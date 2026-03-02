// Provider-specific request mutations — port of src/lib/providers/index.ts:applyProviderSpecificLogic
// and associated provider sub-modules.

import type { OpenRouterChatCompletionRequest, ChatMessage } from '../types/request';
import type { Provider } from './providers';
import type { BYOKResult, VercelUserByokInferenceProviderId } from './byok';
import {
  VercelUserByokInferenceProviderIdSchema,
  AutocompleteUserByokProviderIdSchema,
} from './byok';
import { getKiloFreeModelWithGateway, getPreferredProviderOrder } from './providers';
import {
  hasAttemptCompletionTool,
  normalizeToolCallIds,
  dropToolStrictProperties,
} from './tool-calling';

// --- Model predicates ---

function isAnthropicModel(model: string) {
  return model.startsWith('anthropic/');
}
function isHaikuModel(model: string) {
  return model.startsWith('anthropic/claude-haiku');
}
function isMistralModel(model: string) {
  return model.startsWith('mistralai/');
}
function isXaiModel(model: string) {
  return model.startsWith('x-ai/');
}
function isGeminiModel(model: string) {
  return model.startsWith('google/gemini');
}
function isMoonshotModel(model: string) {
  return model.startsWith('moonshotai/');
}
function isQwenModel(model: string) {
  return model.startsWith('qwen/');
}
function isOpenAiModel(model: string) {
  return model.startsWith('openai/') && !model.startsWith('openai/gpt-oss');
}
function isZaiModel(model: string) {
  return model.startsWith('z-ai/');
}

// --- Anthropic ---

function appendAnthropicBetaHeader(headers: Record<string, string>, flag: string) {
  headers['x-anthropic-beta'] = [headers['x-anthropic-beta'], flag].filter(Boolean).join(',');
}

function hasCacheControl(msg: ChatMessage): boolean {
  return (
    'cache_control' in msg ||
    (Array.isArray(msg.content) &&
      (msg.content as Array<Record<string, unknown>>).some(c => 'cache_control' in c))
  );
}

function setCacheControl(msg: ChatMessage) {
  if (typeof msg.content === 'string') {
    msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(msg.content)) {
    const last = (msg.content as Array<Record<string, unknown>>).at(-1);
    if (last) last.cache_control = { type: 'ephemeral' };
  }
}

function addCacheBreakpoints(messages: ChatMessage[]) {
  const systemPrompt = messages.find(m => m.role === 'system');
  if (!systemPrompt || hasCacheControl(systemPrompt)) return;
  setCacheControl(systemPrompt);
  const lastUser = messages.findLast(m => m.role === 'user' || m.role === 'tool');
  if (lastUser) setCacheControl(lastUser);
}

async function applyAnthropicModelSettings(
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  appendAnthropicBetaHeader(extraHeaders, 'fine-grained-tool-streaming-2025-05-14');
  addCacheBreakpoints(requestToMutate.messages);
  await normalizeToolCallIds(requestToMutate, id => id.includes('.'), undefined);
}

// --- xAI ---

function applyXaiModelSettings(
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  extraHeaders['x-grok-conv-id'] =
    (requestToMutate.prompt_cache_key as string | undefined) || crypto.randomUUID();
  extraHeaders['x-grok-req-id'] = crypto.randomUUID();
}

// --- Google ---

function applyGoogleModelSettings(
  provider: 'vercel' | string,
  requestToMutate: OpenRouterChatCompletionRequest
) {
  if (provider !== 'vercel') return;

  type ReadFileParams = {
    properties?: {
      files?: {
        items?: {
          properties?: { line_ranges?: { type?: unknown; items?: unknown; anyOf?: unknown } };
        };
      };
    };
  };
  const readFileTool = (
    requestToMutate.tools as
      | Array<{ type?: string; function?: { name?: string; parameters?: unknown } }>
      | undefined
  )?.find(t => t.type === 'function' && t.function?.name === 'read_file');
  if (!readFileTool || readFileTool.type !== 'function') return;

  const lineRanges = (readFileTool.function?.parameters as ReadFileParams | undefined)?.properties
    ?.files?.items?.properties?.line_ranges;
  if (lineRanges?.type && lineRanges?.items) {
    lineRanges.anyOf = [{ type: 'null' }, { type: 'array', items: lineRanges.items }];
    delete lineRanges.type;
    delete lineRanges.items;
  }
}

// --- Moonshotai ---

function applyMoonshotProviderSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  delete requestToMutate.temperature;
}

// --- Qwen ---

function applyQwenModelSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  if (requestToMutate.max_tokens) {
    requestToMutate.max_tokens = Math.min(requestToMutate.max_tokens as number, 32768);
  }
  if (requestToMutate.max_completion_tokens) {
    requestToMutate.max_completion_tokens = Math.min(
      requestToMutate.max_completion_tokens as number,
      32768
    );
  }
}

// --- Mistral ---

async function applyMistralModelSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  if (requestToMutate.temperature === undefined) {
    requestToMutate.temperature = 0.2;
  }
  await normalizeToolCallIds(requestToMutate, id => id.length !== 9, 9);
  dropToolStrictProperties(requestToMutate);
  if (hasAttemptCompletionTool(requestToMutate)) {
    requestToMutate.tool_choice = 'required';
  }
}

async function applyMistralProviderSettings(
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  if (requestToMutate.prompt_cache_key) {
    extraHeaders['x-affinity'] = requestToMutate.prompt_cache_key as string;
  }
  for (const msg of requestToMutate.messages) {
    if ('reasoning_details' in msg) delete (msg as Record<string, unknown>).reasoning_details;
  }
  delete requestToMutate.reasoning;
  delete requestToMutate.reasoning_effort;
  delete requestToMutate.transforms;
  delete requestToMutate.safety_identifier;
  delete requestToMutate.prompt_cache_key;
  delete requestToMutate.user;
  delete requestToMutate.provider;
  await applyMistralModelSettings(requestToMutate);
}

// --- CoreThink ---

function applyCoreThinkProviderSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  delete requestToMutate.transforms;
  delete requestToMutate.prompt_cache_key;
  delete requestToMutate.safety_identifier;
  delete requestToMutate.description;
  delete requestToMutate.usage;
  for (const msg of requestToMutate.messages) {
    if ('reasoning' in msg) delete (msg as Record<string, unknown>).reasoning;
    if ('reasoning_details' in msg) delete (msg as Record<string, unknown>).reasoning_details;
  }
}

// --- GigaPotato ---

function applyGigaPotatoProviderSettings(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest
) {
  const nonDisclosureRule = {
    type: 'text' as const,
    text: 'You are an AI assistant in Kilo. Your name is Giga Potato. Do not reveal your model size, architecture, or any information that could hint at your origin or capabilities.',
  };
  const systemPrompt = requestToMutate.messages.find(m => m.role === 'system');
  if (systemPrompt) {
    if (Array.isArray(systemPrompt.content)) {
      (systemPrompt.content as unknown[]).push(nonDisclosureRule);
    } else if (systemPrompt.content) {
      systemPrompt.content = [{ type: 'text', text: systemPrompt.content }, nonDisclosureRule];
    } else {
      systemPrompt.content = [nonDisclosureRule];
    }
  } else {
    requestToMutate.messages.splice(0, 0, { role: 'system', content: [nonDisclosureRule] });
  }
  requestToMutate.thinking = {
    type: requestedModel === 'giga-potato-thinking' ? 'enabled' : 'disabled',
  };
}

// --- Vercel BYOK ---

type VercelInferenceProviderConfig = { apiKey?: string; baseURL?: string } | AwsCredentials;
type AwsCredentials = { accessKeyId: string; secretAccessKey: string; region: string };

function parseAwsCredentials(input: string): AwsCredentials {
  const parsed: unknown = JSON.parse(input);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'accessKeyId' in parsed &&
    'secretAccessKey' in parsed &&
    'region' in parsed
  ) {
    return parsed as AwsCredentials;
  }
  throw new Error('Failed to parse AWS credentials');
}

function getVercelInferenceProviderConfig(
  provider: BYOKResult
): [VercelUserByokInferenceProviderId, VercelInferenceProviderConfig[]] {
  const key =
    provider.providerId === AutocompleteUserByokProviderIdSchema.enum.codestral
      ? VercelUserByokInferenceProviderIdSchema.enum.mistral
      : VercelUserByokInferenceProviderIdSchema.parse(provider.providerId);

  const list: VercelInferenceProviderConfig[] = [];
  if (key === 'zai') {
    list.push({ apiKey: provider.decryptedAPIKey, baseURL: 'https://api.z.ai/api/coding/paas/v4' });
  }
  if (key === 'bedrock') {
    list.push(parseAwsCredentials(provider.decryptedAPIKey));
  } else {
    list.push({ apiKey: provider.decryptedAPIKey });
  }
  return [key, list];
}

function openRouterToVercelProviderId(providerId: string): string {
  const mapping: Record<string, string> = {
    'amazon-bedrock': 'bedrock',
    'google-ai-studio': 'google',
    'google-vertex': 'vertex',
    'z-ai': 'zai',
  };
  const slashIndex = providerId.indexOf('/');
  const normalized = (slashIndex >= 0 ? providerId.slice(0, slashIndex) : providerId).toLowerCase();
  return mapping[normalized] ?? normalized;
}

function applyVercelSettings(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>,
  userByok: BYOKResult[] | null
) {
  // Map to Vercel model ID
  requestToMutate.model = mapModelIdToVercel(requestedModel);

  if (isAnthropicModel(requestedModel)) {
    const existing = extraHeaders['x-anthropic-beta'];
    extraHeaders['anthropic-beta'] = [existing, 'context-1m-2025-08-07'].filter(Boolean).join(',');
    delete extraHeaders['x-anthropic-beta'];
  }

  if (userByok) {
    if (userByok.length === 0) throw new Error('Invalid state: userByok is empty');
    const byokProviders: Record<string, VercelInferenceProviderConfig[]> = {};
    for (const provider of userByok) {
      const [key, list] = getVercelInferenceProviderConfig(provider);
      byokProviders[key] = [...(byokProviders[key] ?? []), ...list];
    }
    requestToMutate.providerOptions = {
      gateway: { only: Object.keys(byokProviders), byok: byokProviders },
    };
  } else {
    const provider = requestToMutate.provider;
    if (provider) {
      requestToMutate.providerOptions = {
        gateway: {
          only: provider.only?.map(openRouterToVercelProviderId),
          order: provider.order?.map(openRouterToVercelProviderId),
          zeroDataRetention: provider.zdr,
        },
      };
    }
  }

  if (requestToMutate.providerOptions && requestToMutate.verbosity) {
    (requestToMutate.providerOptions as Record<string, unknown>).anthropic = {
      effort: requestToMutate.verbosity,
    };
  }

  delete requestToMutate.provider;
}

function mapModelIdToVercel(modelId: string): string {
  const hardcoded: Record<string, string | undefined> = {
    'arcee-ai/trinity-large-preview:free': 'arcee-ai/trinity-large-preview',
    'mistralai/codestral-2508': 'mistral/codestral',
    'mistralai/devstral-2512': 'mistral/devstral-2',
  };
  if (hardcoded[modelId]) return hardcoded[modelId]!;

  const kiloFree = getKiloFreeModelWithGateway(modelId);
  const baseId =
    kiloFree?.is_enabled && kiloFree.gateway === 'OPENROUTER' ? kiloFree.internal_id : modelId;

  const slashIndex = baseId.indexOf('/');
  if (slashIndex < 0) return baseId;

  const prefixToVercel: Record<string, string | undefined> = {
    anthropic: 'anthropic',
    google: 'google',
    openai: 'openai',
    minimax: 'minimax',
    mistralai: 'mistral',
    'x-ai': 'xai',
    'z-ai': 'zai',
  };
  const prefix = baseId.slice(0, slashIndex);
  const isGptOss = baseId.startsWith('openai/gpt-oss');
  const vercelProvider = isGptOss ? undefined : prefixToVercel[prefix];
  return vercelProvider ? vercelProvider + baseId.slice(slashIndex) : baseId;
}

// --- Kilo free model internal_id mapping ----

function applyKiloFreeModelSettings(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest
) {
  const kiloFreeModel = getKiloFreeModelWithGateway(requestedModel);
  if (!kiloFreeModel) return;
  requestToMutate.model = kiloFreeModel.internal_id;
  if (kiloFreeModel.inference_providers.length > 0) {
    requestToMutate.provider = { only: kiloFreeModel.inference_providers };
  }
}

// --- Preferred provider (OpenRouter routing hints) ---

function applyPreferredProvider(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest
) {
  const order = getPreferredProviderOrder(requestedModel);
  if (order.length === 0) return;
  if (!requestToMutate.provider) {
    requestToMutate.provider = { order };
  } else if (!requestToMutate.provider.order) {
    requestToMutate.provider.order = order;
  }
}

// --- tool_choice: required ---

async function applyToolChoiceSetting(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest
) {
  if (!hasAttemptCompletionTool(requestToMutate)) return;
  const isReasoningEnabled =
    (requestToMutate.reasoning?.enabled ?? false) === true ||
    (requestToMutate.reasoning?.effort ?? 'none') !== 'none' ||
    ((requestToMutate.reasoning?.max_tokens as number | undefined) ?? 0) > 0;
  if (
    isXaiModel(requestedModel) ||
    isOpenAiModel(requestedModel) ||
    isGeminiModel(requestedModel) ||
    (isHaikuModel(requestedModel) && !isReasoningEnabled)
  ) {
    requestToMutate.tool_choice = 'required';
  }
}

// --- Main entry point ---

export async function applyProviderSpecificLogic(
  provider: Provider,
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>,
  userByok: BYOKResult[] | null
): Promise<void> {
  applyKiloFreeModelSettings(requestedModel, requestToMutate);

  if (isAnthropicModel(requestedModel)) {
    await applyAnthropicModelSettings(requestToMutate, extraHeaders);
  }

  await applyToolChoiceSetting(requestedModel, requestToMutate);

  applyPreferredProvider(requestedModel, requestToMutate);

  if (isXaiModel(requestedModel)) {
    applyXaiModelSettings(requestToMutate, extraHeaders);
  }

  if (isGeminiModel(requestedModel)) {
    applyGoogleModelSettings(provider.id, requestToMutate);
  }

  if (isMoonshotModel(requestedModel)) {
    applyMoonshotProviderSettings(requestToMutate);
  }

  if (isQwenModel(requestedModel)) {
    applyQwenModelSettings(requestToMutate);
  }

  if (provider.id === 'gigapotato') {
    applyGigaPotatoProviderSettings(requestedModel, requestToMutate);
  }

  if (provider.id === 'corethink') {
    applyCoreThinkProviderSettings(requestToMutate);
  }

  if (provider.id === 'mistral') {
    await applyMistralProviderSettings(requestToMutate, extraHeaders);
  } else if (isMistralModel(requestedModel)) {
    await applyMistralModelSettings(requestToMutate);
  }

  if (isZaiModel(requestedModel)) {
    // Z.AI uses specific routing
  }

  if (provider.id === 'vercel') {
    applyVercelSettings(requestedModel, requestToMutate, extraHeaders, userByok);
  }
}
