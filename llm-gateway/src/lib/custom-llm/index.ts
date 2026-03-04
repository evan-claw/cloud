// Custom LLM request handler — port of src/lib/custom-llm/customLlmRequest.ts.
// Uses Vercel AI SDK for Anthropic and OpenAI-compatible endpoints.
// Adapted for Cloudflare Workers: no Node.js crypto, no global DB, no Next.js.

import type { OpenRouterChatCompletionRequest } from '../../types/request';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import {
  APICallError,
  generateText,
  jsonSchema,
  streamText,
  type ModelMessage,
  type TextStreamPart,
  type ToolChoice,
  type ToolSet,
} from 'ai';
import type { CustomLlm } from '@kilocode/db/schema';
import type { OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
import { createOpenAI } from '@ai-sdk/openai';
import { ReasoningDetailType } from './reasoning-details';
import type { ReasoningDetailUnion } from './reasoning-details';
import {
  reasoningDetailsToAiSdkParts,
  reasoningOutputToDetails,
  extractSignature,
  extractEncryptedData,
  extractItemId,
  extractFormat,
  type AiSdkReasoningPart,
} from './reasoning-provider-metadata';
import { ReasoningFormat } from './format';
import type { WorkerDb } from '@kilocode/db/client';
import { temp_phase } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import { VerbositySchema, ReasoningEffortSchema } from '@kilocode/db/schema-types';

// ─── Types ───────────────────────────────────────────────────────────────────

type OpenRouterCacheControl = { type: 'ephemeral' };

type ChatCompletionContentPartText = {
  type: 'text';
  text: string;
  reasoning?: string | null;
  cache_control?: OpenRouterCacheControl;
};
type ChatCompletionContentPartImage = {
  type: 'image_url';
  image_url: { url: string };
  cache_control?: OpenRouterCacheControl;
};
type ChatCompletionContentPartFile = {
  type: 'file';
  file: { filename?: string; file_data?: string; file_id?: string };
  cache_control?: OpenRouterCacheControl;
};
type ChatCompletionContentPartInputAudio = {
  type: 'input_audio';
  input_audio: { data: string; format: string };
  cache_control?: OpenRouterCacheControl;
};

type ChatCompletionContentPart =
  | ChatCompletionContentPartText
  | ChatCompletionContentPartImage
  | ChatCompletionContentPartFile
  | ChatCompletionContentPartInputAudio;

type ChatCompletionToolMessageParam = {
  role: 'tool';
  tool_call_id: string;
  content: string | Array<ChatCompletionContentPart>;
};

type ChatCompletionAssistantMessageParam = {
  role: 'assistant';
  content?: string;
  reasoning?: string;
  reasoning_details?: ReasoningDetailUnion[];
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
};

type ChatCompletionSystemMessageParam = {
  role: 'system';
  content: string | Array<ChatCompletionContentPartText>;
};

type ChatCompletionUserMessageParam = {
  role: 'user';
  content: string | Array<ChatCompletionContentPart>;
  cache_control?: OpenRouterCacheControl;
};

type ChatCompletionMessageParam =
  | ChatCompletionSystemMessageParam
  | ChatCompletionUserMessageParam
  | ChatCompletionAssistantMessageParam
  | ChatCompletionToolMessageParam;

type OpenRouterChatCompletionsInput = Array<ChatCompletionMessageParam>;

type ChatCompletionChunkChoice = {
  delta?: {
    content?: string | null;
    reasoning?: string;
    reasoning_details?: ReasoningDetailUnion[];
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: 'function';
      function?: { name?: string; arguments?: string };
    }>;
    role?: string | null;
    [key: string]: unknown;
  };
  finish_reason?: string | null;
  [key: string]: unknown;
};

type ChatCompletionChunk = {
  id?: string;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens: number };
  };
  [key: string]: unknown;
};

// ─── Crypto helpers ───────────────────────────────────────────────────────────

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function phaseKey(
  userId: string,
  taskId: string | undefined,
  content: string[]
): Promise<string> {
  return sha256Hex([userId, taskId, ...content].join('|'));
}

// ─── Message conversion ───────────────────────────────────────────────────────

function extractMessageTextParts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return (content as Array<Record<string, unknown>>)
    .filter(
      (part): part is { type: string; text: string } =>
        part !== null &&
        typeof part === 'object' &&
        (part['type'] === 'input_text' || part['type'] === 'output_text') &&
        typeof part['text'] === 'string'
    )
    .map(p => p.text);
}

type ToolOutputContentPart =
  | { type: 'text'; text: string }
  | { type: 'media'; data: string; mediaType: string };

function parseDataUrl(url: string): { data: string; mediaType: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (match) return { mediaType: match[1], data: match[2] };
  return null;
}

const AUDIO_MEDIA_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  aiff: 'audio/aiff',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  pcm16: 'audio/pcm',
  pcm24: 'audio/pcm',
};

function audioFormatToMediaType(format: string): string {
  return AUDIO_MEDIA_TYPES[format] ?? 'application/octet-stream';
}

function convertToolOutputPart(part: ChatCompletionContentPart): ToolOutputContentPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image_url': {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) return { type: 'media', data: parsed.data, mediaType: parsed.mediaType };
      return { type: 'text', text: part.image_url.url };
    }
    case 'file': {
      const parsed = part.file.file_data ? parseDataUrl(part.file.file_data) : null;
      if (parsed) return { type: 'media', data: parsed.data, mediaType: parsed.mediaType };
      return { type: 'text', text: part.file.file_data ?? '' };
    }
    case 'input_audio':
      return {
        type: 'media',
        data: part.input_audio.data,
        mediaType: audioFormatToMediaType(part.input_audio.format),
      };
  }
}

function convertToolOutput(content: string | Array<ChatCompletionContentPart>) {
  if (typeof content === 'string') return { type: 'text' as const, value: content };
  const parts: ToolOutputContentPart[] = content.map(convertToolOutputPart);
  return { type: 'content' as const, value: parts };
}

function convertUserContentPart(part: ChatCompletionContentPart) {
  const providerOptions = part.cache_control
    ? { anthropic: { cacheControl: part.cache_control } }
    : undefined;
  switch (part.type) {
    case 'text':
      return {
        type: 'text' as const,
        text: part.text,
        ...(providerOptions && { providerOptions }),
      };
    case 'image_url':
      return {
        type: 'image' as const,
        image: new URL(part.image_url.url),
        ...(providerOptions && { providerOptions }),
      };
    case 'file':
      return {
        type: 'file' as const,
        data: part.file.file_data ?? '',
        filename: part.file.filename,
        mediaType: parseDataUrl(part.file.file_data ?? '')?.mediaType ?? 'application/octet-stream',
        ...(providerOptions && { providerOptions }),
      };
    case 'input_audio':
      return {
        type: 'file' as const,
        data: part.input_audio.data,
        mediaType: audioFormatToMediaType(part.input_audio.format),
        ...(providerOptions && { providerOptions }),
      };
  }
}

type AssistantContentPart =
  | { type: 'text'; text: string }
  | AiSdkReasoningPart
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown };

function convertAssistantContent(
  msg: ChatCompletionAssistantMessageParam
): string | AssistantContentPart[] {
  const parts: AssistantContentPart[] = [];

  if (msg.reasoning_details && msg.reasoning_details.length > 0) {
    for (const p of reasoningDetailsToAiSdkParts(msg.reasoning_details)) parts.push(p);
  } else if (msg.reasoning) {
    parts.push({ type: 'reasoning', text: msg.reasoning });
  }

  if (msg.content) parts.push({ type: 'text', text: msg.content });

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      parts.push({
        type: 'tool-call',
        toolCallId: tc.id,
        toolName: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts.length > 0 ? parts : '';
}

function convertMessages(messages: OpenRouterChatCompletionsInput): ModelMessage[] {
  const toolNameByCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) toolNameByCallId.set(tc.id, tc.function.name);
    }
  }

  return messages.map((msg): ModelMessage => {
    switch (msg.role) {
      case 'system':
        return {
          role: 'system',
          content:
            typeof msg.content === 'string' ? msg.content : msg.content.map(p => p.text).join(''),
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        };
      case 'user': {
        const content =
          typeof msg.content === 'string' ? msg.content : msg.content.map(convertUserContentPart);
        return {
          role: 'user',
          content,
          ...(msg.cache_control && {
            providerOptions: { anthropic: { cacheControl: msg.cache_control } },
          }),
        };
      }
      case 'assistant':
        return { role: 'assistant', content: convertAssistantContent(msg) };
      case 'tool':
        return {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: msg.tool_call_id,
              toolName: toolNameByCallId.get(msg.tool_call_id) ?? '',
              output: convertToolOutput(msg.content),
            },
          ],
        };
    }
  });
}

// ─── Tool conversion ───────────────────────────────────────────────────────────

function convertTools(tools: OpenRouterChatCompletionRequest['tools']): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const result: ToolSet = {};
  const toolsArr = tools as Array<{
    type: string;
    function: { name: string; description?: string; parameters?: unknown; strict?: boolean };
  }>;
  for (const t of toolsArr) {
    if (t.type !== 'function') continue;
    result[t.function.name] = {
      description: t.function.description,
      strict: t.function.strict ?? undefined,
      inputSchema: jsonSchema(
        (t.function.parameters as Record<string, unknown>) ?? { type: 'object' }
      ),
    };
  }
  return result;
}

function convertToolChoice(
  toolChoice: OpenRouterChatCompletionRequest['tool_choice']
): ToolChoice<ToolSet> | undefined {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (toolChoice === 'none' || toolChoice === 'auto' || toolChoice === 'required')
    return toolChoice as ToolChoice<ToolSet>;
  if (typeof toolChoice === 'object' && 'type' in toolChoice && toolChoice.type === 'function') {
    const tc = toolChoice as { type: 'function'; function: { name: string } };
    return { type: 'tool', toolName: tc.function.name };
  }
  return undefined;
}

// ─── Common params builder ─────────────────────────────────────────────────────

function buildCommonParams(
  customLlm: CustomLlm,
  messages: ModelMessage[],
  request: OpenRouterChatCompletionRequest,
  isLegacyExtension: boolean
) {
  const verbosity = VerbositySchema.safeParse(request.verbosity ?? customLlm.verbosity).data;
  const reasoningEffort = ReasoningEffortSchema.safeParse(
    request.reasoning?.effort ?? customLlm.reasoning_effort
  ).data;
  return {
    messages,
    tools: convertTools(request.tools),
    toolChoice: convertToolChoice(request.tool_choice),
    maxOutputTokens:
      (request['max_completion_tokens'] as number | undefined) ?? request.max_tokens ?? undefined,
    temperature: (request.temperature as number | undefined) ?? undefined,
    headers: { 'anthropic-beta': 'context-1m-2025-08-07' },
    providerOptions: {
      anthropic: {
        thinking: { type: 'adaptive' },
        effort: verbosity,
        disableParallelToolUse:
          (request['parallel_tool_calls'] as boolean | undefined) === false || isLegacyExtension,
      } satisfies AnthropicProviderOptions,
      openai: {
        forceReasoning: (reasoningEffort !== 'none' && customLlm.force_reasoning) || undefined,
        reasoningSummary: 'auto',
        textVerbosity: verbosity === 'max' ? 'high' : verbosity,
        reasoningEffort,
        include: ['reasoning.encrypted_content'],
        parallelToolCalls:
          ((request['parallel_tool_calls'] as boolean | undefined) ?? true) && !isLegacyExtension,
        store: false,
        promptCacheKey: request.prompt_cache_key,
        safetyIdentifier: request.safety_identifier,
        user: request.user,
      } satisfies OpenAILanguageModelResponsesOptions,
    },
  };
}

// ─── Non-streaming response converter ────────────────────────────────────────

function convertGenerateResultToResponse(
  result: Awaited<ReturnType<typeof generateText>>,
  model: string
) {
  const toolCalls = result.toolCalls.map((tc, i) => ({
    id: tc.toolCallId,
    type: 'function' as const,
    index: i,
    function: { name: tc.toolName, arguments: JSON.stringify(tc.input) },
  }));

  const reasoning_details =
    result.reasoning.length > 0 ? reasoningOutputToDetails(result.reasoning) : undefined;

  return {
    id: result.response.id,
    model,
    choices: [
      {
        message: {
          role: 'assistant' as const,
          content: result.text || null,
          ...(result.reasoningText ? { reasoning: result.reasoningText } : {}),
          ...(reasoning_details ? { reasoning_details } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: FINISH_REASON_MAP[result.finishReason] ?? 'stop',
        index: 0,
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens ?? 0,
      completion_tokens: result.usage.outputTokens ?? 0,
      total_tokens: result.usage.totalTokens ?? 0,
      ...(result.usage.inputTokenDetails.cacheReadTokens != null ||
      result.usage.inputTokenDetails.cacheWriteTokens != null
        ? {
            prompt_tokens_details: {
              cached_tokens: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
              ...(result.usage.inputTokenDetails.cacheWriteTokens != null && {
                cache_write_tokens: result.usage.inputTokenDetails.cacheWriteTokens,
              }),
            },
          }
        : {}),
      ...(result.usage.outputTokenDetails.reasoningTokens != null
        ? {
            completion_tokens_details: {
              reasoning_tokens: result.usage.outputTokenDetails.reasoningTokens,
            },
          }
        : {}),
    },
  };
}

// ─── Streaming chunk converter ────────────────────────────────────────────────

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'stop',
  length: 'length',
  'content-filter': 'content_filter',
  'tool-calls': 'tool_calls',
  error: 'error',
  other: 'stop',
};

function createStreamPartConverter(
  userId: string,
  taskId: string | undefined,
  model: string,
  db: WorkerDb | null
) {
  const toolCallIndices = new Map<string, number>();
  let nextToolIndex = 0;
  let nextReasoningIndex = 0;
  let currentTextBlockIndex: number | null = null;
  let inReasoningBlock = false;
  let responseId: string | undefined;

  return async function convertStreamPartToChunk(
    part: TextStreamPart<ToolSet>
  ): Promise<ChatCompletionChunk | null> {
    const id = responseId;
    switch (part.type) {
      case 'raw': {
        // Handle phase metadata insertion for OpenAI responses
        if (db) {
          type ResponseItemDone = {
            type: string;
            item?: {
              type?: string;
              phase?: string;
              content?: Array<{ type: string; text?: string }>;
            };
          };
          const event = part.rawValue as ResponseItemDone;
          if (event.type === 'response.output_item.done' && event.item) {
            const item = event.item;
            const phase = typeof item.phase === 'string' ? item.phase : null;
            if (item.type === 'message' && phase && Array.isArray(item.content)) {
              const key = await phaseKey(
                userId,
                taskId,
                item.content.filter(c => c.type === 'output_text').map(c => c.text ?? '')
              );
              await db.insert(temp_phase).values({ key, value: phase }).onConflictDoNothing();
            }
          }
        }
        return null;
      }

      case 'text-delta':
        return {
          ...(id !== undefined ? { id } : {}),
          model,
          choices: [{ delta: { content: part.text } }],
        };

      case 'reasoning-start': {
        const encData = extractEncryptedData(part.providerMetadata);
        if (encData) {
          const itemId = extractItemId(part.providerMetadata);
          const format = extractFormat(part.providerMetadata);
          const index = nextReasoningIndex++;
          return {
            ...(id !== undefined ? { id } : {}),
            model,
            choices: [
              {
                delta: {
                  reasoning_details: [
                    {
                      type: ReasoningDetailType.Encrypted,
                      data: encData,
                      index,
                      ...(itemId ? { id: itemId } : {}),
                      ...(format ? { format } : {}),
                    },
                  ],
                },
              },
            ],
          };
        }
        inReasoningBlock = true;
        return null;
      }

      case 'reasoning-delta': {
        const details: ReasoningDetailUnion[] = [];
        const signature = extractSignature(part.providerMetadata);
        const format = extractFormat(part.providerMetadata);

        if (part.text) {
          if (inReasoningBlock) {
            currentTextBlockIndex = nextReasoningIndex++;
            inReasoningBlock = false;
          }
          const itemId = extractItemId(part.providerMetadata);
          details.push({
            type: ReasoningDetailType.Text,
            text: part.text,
            index: currentTextBlockIndex ?? 0,
            ...(signature ? { signature } : {}),
            ...(itemId ? { id: itemId } : {}),
            ...(format ? { format } : {}),
          });
        } else if (signature) {
          details.push({
            type: ReasoningDetailType.Text,
            text: '',
            signature,
            index: currentTextBlockIndex ?? 0,
            ...(format ? { format } : {}),
          });
        }

        if (details.length === 0) return null;
        return {
          ...(id !== undefined ? { id } : {}),
          model,
          choices: [{ delta: { reasoning: part.text || '', reasoning_details: details } }],
        };
      }

      case 'reasoning-end': {
        const encData = extractEncryptedData(part.providerMetadata);
        const signature = extractSignature(part.providerMetadata);
        if (!encData && !signature) return null;

        const details: ReasoningDetailUnion[] = [];
        const itemId = extractItemId(part.providerMetadata);
        const format = extractFormat(part.providerMetadata);

        if (encData) {
          details.push({
            type: ReasoningDetailType.Encrypted,
            data: encData,
            index: nextReasoningIndex++,
            ...(itemId ? { id: itemId } : {}),
            ...(format ? { format } : {}),
          });
        }
        if (signature) {
          details.push({
            type: ReasoningDetailType.Text,
            text: '',
            signature,
            index: currentTextBlockIndex ?? 0,
            ...(itemId ? { id: itemId } : {}),
            ...(format ? { format } : {}),
          });
        }
        return {
          ...(id !== undefined ? { id } : {}),
          model,
          choices: [{ delta: { reasoning_details: details } }],
        };
      }

      case 'tool-input-start': {
        const index = nextToolIndex++;
        toolCallIndices.set(part.id, index);
        return {
          ...(id !== undefined ? { id } : {}),
          model,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: part.id,
                    type: 'function' as const,
                    function: { name: part.toolName },
                  },
                ],
              },
            },
          ],
        };
      }

      case 'tool-input-delta': {
        const index = toolCallIndices.get(part.id) ?? 0;
        return {
          ...(id !== undefined ? { id } : {}),
          model,
          choices: [{ delta: { tool_calls: [{ index, function: { arguments: part.delta } }] } }],
        };
      }

      case 'tool-call': {
        if (toolCallIndices.has(part.toolCallId)) return null;
        const index = nextToolIndex++;
        return {
          ...(id !== undefined ? { id } : {}),
          model,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: part.toolCallId,
                    type: 'function' as const,
                    function: { name: part.toolName, arguments: JSON.stringify(part.input) },
                  },
                ],
              },
            },
          ],
        };
      }

      case 'finish-step': {
        responseId = part.response.id;
        const cRd = part.usage.inputTokenDetails.cacheReadTokens;
        const cWr = part.usage.inputTokenDetails.cacheWriteTokens;
        const rsnTok = part.usage.outputTokenDetails.reasoningTokens;
        return {
          id: responseId,
          model,
          choices: [{ delta: {}, finish_reason: FINISH_REASON_MAP[part.finishReason] ?? 'stop' }],
          usage: {
            prompt_tokens: part.usage.inputTokens ?? 0,
            completion_tokens: part.usage.outputTokens ?? 0,
            total_tokens: part.usage.totalTokens ?? 0,
            ...(cRd != null || cWr != null
              ? {
                  prompt_tokens_details: {
                    cached_tokens: cRd ?? 0,
                    ...(cWr != null && { cache_write_tokens: cWr }),
                  },
                }
              : {}),
            ...(rsnTok != null ? { completion_tokens_details: { reasoning_tokens: rsnTok } } : {}),
          },
        };
      }

      default:
        return null;
    }
  };
}

// ─── Legacy extension hack (OpenAIResponsesV1 ↔ OpenAIResponsesV1_Obscured) ──

function reverseLegacyExtensionHack(messages: OpenRouterChatCompletionsInput) {
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const rd of msg.reasoning_details ?? []) {
        if (rd.format === ReasoningFormat.OpenAIResponsesV1_Obscured) {
          rd.format = ReasoningFormat.OpenAIResponsesV1;
        }
      }
    }
  }
}

function applyLegacyExtensionHack(choice: ChatCompletionChunkChoice | undefined) {
  for (const rd of choice?.delta?.reasoning_details ?? []) {
    if (rd.format === ReasoningFormat.OpenAIResponsesV1) {
      rd.format = ReasoningFormat.OpenAIResponsesV1_Obscured;
    }
  }
}

// ─── Model factory ────────────────────────────────────────────────────────────

function createModel(
  customLlm: CustomLlm,
  userId: string,
  taskId: string | undefined,
  db: WorkerDb | null
) {
  if (customLlm.provider === 'anthropic') {
    const anthropic = createAnthropic({ apiKey: customLlm.api_key, baseURL: customLlm.base_url });
    return anthropic(customLlm.internal_id);
  }
  if (customLlm.provider === 'openai') {
    const patchedFetch =
      customLlm.base_url === 'https://api.openai.com/v1' && db
        ? responseCreateParamsPatchFetch(userId, taskId, db)
        : undefined;
    const openai = createOpenAI({
      apiKey: customLlm.api_key,
      baseURL: customLlm.base_url,
      fetch: patchedFetch,
    });
    return openai(customLlm.internal_id);
  }
  throw new Error(`Unknown custom LLM provider: ${customLlm.provider}`);
}

// Patches the OpenAI Responses API request to inject `phase` into assistant messages.
function responseCreateParamsPatchFetch(userId: string, taskId: string | undefined, db: WorkerDb) {
  return async function (input: string | URL | Request, init?: RequestInit) {
    if (typeof init?.body === 'string') {
      type ResponseCreateParams = {
        input?: Array<{ role?: string; content?: unknown; phase?: string }>;
      };
      let json: ResponseCreateParams | undefined;
      try {
        json = JSON.parse(init.body) as ResponseCreateParams;
      } catch {
        // Not valid JSON — pass through unmodified
      }
      if (json && Array.isArray(json.input)) {
        const assistantMessages = json.input.filter(m => 'role' in m && m.role === 'assistant');

        if (assistantMessages.length > 0) {
          const keyByMessage = new Map<(typeof assistantMessages)[number], string>();
          for (const msg of assistantMessages) {
            keyByMessage.set(
              msg,
              await phaseKey(userId, taskId, extractMessageTextParts(msg.content))
            );
          }

          const keys = [...new Set(keyByMessage.values())];
          const rows = await db
            .select({ key: temp_phase.key, phase: temp_phase.value })
            .from(temp_phase)
            .where(inArray(temp_phase.key, keys));
          const phaseByKey = new Map(rows.map(r => [r.key, r.phase]));

          for (const msg of assistantMessages) {
            const phase = phaseByKey.get(keyByMessage.get(msg) ?? '');
            if (phase) {
              Object.assign(msg, { phase });
            } else {
              console.error(
                `[responseCreateParamsPatchFetch] failed to find phase for userId: ${userId}, taskId: ${taskId}`
              );
            }
          }
          init = { ...init, body: JSON.stringify(json) };
        }
      }
    }
    return fetch(input, init);
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function customLlmRequest(
  customLlm: CustomLlm,
  request: OpenRouterChatCompletionRequest,
  userId: string,
  taskId: string | undefined,
  isLegacyExtension: boolean,
  db: WorkerDb | null
): Promise<Response> {
  const messages = request.messages as OpenRouterChatCompletionsInput;
  if (isLegacyExtension) reverseLegacyExtensionHack(messages);

  const model = createModel(customLlm, userId, taskId, db);
  const commonParams = buildCommonParams(
    customLlm,
    convertMessages(messages),
    request,
    isLegacyExtension
  );
  const modelId = customLlm.public_id;

  if (!request.stream) {
    try {
      const result = await generateText({ model, ...commonParams });
      const converted = convertGenerateResultToResponse(result, modelId);
      return Response.json(converted);
    } catch (e) {
      console.error('Caught exception while processing non-streaming custom LLM request', e);
      const status = APICallError.isInstance(e) ? (e.statusCode ?? 500) : 500;
      const msg = e instanceof Error ? e.message : 'Generation failed';
      return Response.json({ error: { message: msg, code: status, type: 'error' } }, { status });
    }
  }

  const result = streamText({ model, ...commonParams, includeRawChunks: true });
  const convertStreamPartToChunk = createStreamPartConverter(userId, taskId, modelId, db);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.fullStream) {
          const converted = await convertStreamPartToChunk(chunk);
          if (converted) {
            if (isLegacyExtension) {
              applyLegacyExtensionHack(converted.choices[0]);
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(converted)}\n\n`));
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error('Caught exception while processing streaming custom LLM request', e);
        const errorChunk = {
          error: {
            message: e instanceof Error ? e.message : 'Stream error',
            code: APICallError.isInstance(e) ? (e.statusCode ?? 500) : 500,
            ...(APICallError.isInstance(e) && e.responseBody
              ? { metadata: { raw: e.responseBody } }
              : {}),
            type: 'error',
          },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
