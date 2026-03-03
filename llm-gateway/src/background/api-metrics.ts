// Background task: emit API metrics to the O11Y service binding via RPC.
// The O11Y worker exposes an ingestApiMetrics RPC method on its WorkerEntrypoint,
// eliminating the need for HTTP routing, JSON serialization, and admin token auth.

import { createParser } from 'eventsource-parser';
import type { EventSourceMessage } from 'eventsource-parser';
import { z } from 'zod';
import type { ApiMetricsParams } from '@kilocode/worker-utils';

export type { ApiMetricsParams };

export type ApiMetricsTokens = NonNullable<ApiMetricsParams['tokens']>;

// ─── Token extraction ─────────────────────────────────────────────────────────

type OpenAICompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

export function getTokensFromCompletionUsage(
  usage: OpenAICompletionUsage | null | undefined
): ApiMetricsTokens | undefined {
  if (!usage) return undefined;

  const tokens: ApiMetricsTokens = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheHitTokens: usage.prompt_tokens_details?.cached_tokens,
    totalTokens: usage.total_tokens,
    cacheWriteTokens: undefined,
  };

  const hasAny =
    tokens.inputTokens !== undefined ||
    tokens.outputTokens !== undefined ||
    tokens.cacheWriteTokens !== undefined ||
    tokens.cacheHitTokens !== undefined ||
    tokens.totalTokens !== undefined;

  return hasAny ? tokens : undefined;
}

type ChatCompletionTool = {
  type?: string;
  function?: { name?: string };
  custom?: { name?: string };
};

function isTool(item: unknown): item is ChatCompletionTool {
  return typeof item === 'object' && item !== null;
}

export function getToolsAvailable(tools: unknown[] | undefined): string[] {
  if (!tools) return [];
  return tools.map(item => {
    if (!isTool(item)) return 'unknown:unknown';
    if (item.type === 'function') {
      const name = typeof item.function?.name === 'string' ? item.function.name.trim() : '';
      return name ? `function:${name}` : 'function:unknown';
    }
    if (item.type === 'custom') {
      const name = typeof item.custom?.name === 'string' ? item.custom.name.trim() : '';
      return name ? `custom:${name}` : 'custom:unknown';
    }
    return 'unknown:unknown';
  });
}

type AssistantMessage = {
  role?: string;
  tool_calls?: Array<{
    type?: string;
    function?: { name?: string };
    custom?: { name?: string };
  }>;
};

export function getToolsUsed(messages: AssistantMessage[] | undefined): string[] {
  if (!messages) return [];
  const used: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.type === 'function') {
        const name =
          typeof toolCall.function?.name === 'string' ? toolCall.function.name.trim() : '';
        used.push(name ? `function:${name}` : 'function:unknown');
      } else if (toolCall.type === 'custom') {
        const name = typeof toolCall.custom?.name === 'string' ? toolCall.custom.name.trim() : '';
        used.push(name ? `custom:${name}` : 'custom:unknown');
      } else {
        used.push('unknown:unknown');
      }
    }
  }
  return used;
}

// ─── Inference provider extraction ───────────────────────────────────────────

const inferenceProviderSchema = z.object({
  provider: z.string().min(1).optional(),
  choices: z
    .array(
      z.object({
        message: z
          .object({
            provider_metadata: z
              .object({
                gateway: z
                  .object({ routing: z.object({ finalProvider: z.string().min(1).optional() }) })
                  .partial()
                  .optional(),
              })
              .partial()
              .optional(),
          })
          .partial()
          .optional(),
        delta: z
          .object({
            provider_metadata: z
              .object({
                gateway: z
                  .object({ routing: z.object({ finalProvider: z.string().min(1).optional() }) })
                  .partial()
                  .optional(),
              })
              .partial()
              .optional(),
          })
          .partial()
          .optional(),
      })
    )
    .optional(),
});

function extractInferenceProvider(data: unknown): string | undefined {
  const parsed = inferenceProviderSchema.safeParse(data);
  if (!parsed.success) return undefined;
  const directProvider = parsed.data.provider?.trim();
  if (directProvider) return directProvider;
  const choice = parsed.data.choices?.[0];
  const finalProvider =
    choice?.message?.provider_metadata?.gateway?.routing?.finalProvider?.trim() ??
    choice?.delta?.provider_metadata?.gateway?.routing?.finalProvider?.trim();
  return finalProvider || undefined;
}

function safeParseJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

async function drainResponseBodyForInferenceProvider(
  response: Response,
  timeoutMs: number
): Promise<string | undefined> {
  const body = response.body;
  if (!body) return undefined;

  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const contentType = response.headers.get('content-type') ?? '';
  const isEventStream = contentType.includes('text/event-stream');

  try {
    const startedAt = performance.now();
    const decoder = new TextDecoder();
    let inferenceProvider: string | undefined;

    const sseParser = isEventStream
      ? createParser({
          onEvent(event: EventSourceMessage) {
            if (event.data === '[DONE]') return;
            const json = safeParseJson(event.data);
            if (!json) return;
            inferenceProvider = extractInferenceProvider(json);
          },
        })
      : null;

    let buffered = '';
    const MAX_BUFFER_CHARS = 512_000;

    while (true) {
      const elapsedMs = performance.now() - startedAt;
      const remainingMs = timeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        try {
          await reader.cancel();
        } catch {
          /* intentionally empty */
        }
        return inferenceProvider;
      }

      const result = await Promise.race([
        reader.read(),
        scheduler.wait(remainingMs).then(() => ({ timeout: true }) as const),
      ]);

      if ('timeout' in result) {
        try {
          await reader.cancel();
        } catch {
          /* intentionally empty */
        }
        return inferenceProvider;
      }

      if (result.done) {
        if (!inferenceProvider && !isEventStream && buffered) {
          const json = safeParseJson(buffered);
          inferenceProvider = json ? extractInferenceProvider(json) : undefined;
        }
        return inferenceProvider;
      }

      if (result.value) {
        const chunk = decoder.decode(result.value, { stream: true });
        if (sseParser) {
          sseParser.feed(chunk);
        } else if (buffered.length < MAX_BUFFER_CHARS) {
          buffered += chunk;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── O11Y service binding type (RPC) ──────────────────────────────────────────

type O11YRpc = { ingestApiMetrics(params: ApiMetricsParams): Promise<void> };

// ─── Main entry point ─────────────────────────────────────────────────────────

async function sendApiMetrics(o11y: O11YRpc, params: ApiMetricsParams): Promise<void> {
  try {
    await o11y.ingestApiMetrics(params);
  } catch (err) {
    console.error('[api-metrics] Failed to send metrics:', err);
  }
}

/**
 * Drain the background response stream to extract inferenceProvider,
 * then emit the final ApiMetricsParams to O11Y via RPC. Bounded to 60s internally.
 */
export async function runApiMetrics(
  o11y: O11YRpc,
  params: Omit<ApiMetricsParams, 'completeRequestMs'>,
  backgroundStream: ReadableStream,
  requestStartedAt: number
): Promise<void> {
  let inferenceProvider: string | undefined;
  try {
    inferenceProvider = await drainResponseBodyForInferenceProvider(
      new Response(backgroundStream, {
        headers: { 'content-type': params.isStreaming ? 'text/event-stream' : 'application/json' },
      }),
      60_000
    );
  } catch {
    /* ignore drain errors — still emit timing */
  }

  const completeRequestMs = Math.max(0, Math.round(performance.now() - requestStartedAt));

  await sendApiMetrics(o11y, {
    ...params,
    inferenceProvider: inferenceProvider ?? params.inferenceProvider,
    completeRequestMs,
  });
}
