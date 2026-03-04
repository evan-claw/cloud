// Background tasks scheduled via ctx.waitUntil() after the client response is sent.
// Stream parsing runs in-process (fast, in-memory replay of buffered chunks), then
// usage accounting and API metrics messages are enqueued to a Cloudflare Queue for
// processing with automatic retries and no waitUntil budget pressure.
// Request logging stays in-process (simple, employees-only).

import { getWorkerDb } from '@kilocode/db/client';
import {
  parseMicrodollarUsageFromStream,
  parseMicrodollarUsageFromString,
  type MicrodollarUsageContext,
  type MicrodollarUsageStats,
} from '../background/usage-accounting';
import { drainResponseBodyForInferenceProvider } from '../background/api-metrics';
import { runRequestLogging } from '../background/request-logging';
import { extractPromptInfo, estimateChatTokens } from '../lib/prompt-info';
import { normalizeModelId } from '../lib/models';
import { getToolsAvailable, type getToolsUsed } from '../background/api-metrics';
import type { FraudDetectionHeaders } from '../lib/extract-headers';
import type { FeatureValue } from '../lib/feature-detection';
import type { OpenRouterChatCompletionRequest } from '../types/request';
import type { ApiMetricsParams } from '@kilocode/worker-utils';
import type { AbuseServiceSecrets } from '../lib/abuse-service';
import type { BackgroundTaskMessage } from '../queue/messages';

const BACKGROUND_TASK_TIMEOUT_MS = 25_000;

// Wrap a promise to never exceed a max duration, so waitUntil budgets are bounded.
// Uses scheduler.wait (Workers-native) instead of setTimeout for proper I/O scheduling.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, scheduler.wait(ms).then(() => undefined)]);
}

type BgUser = {
  id: string;
  google_user_email?: string;
  microdollars_used?: number;
};

export type BackgroundTaskParams = {
  accountingStream: ReadableStream<Uint8Array> | null;
  metricsStream: ReadableStream | null;
  loggingStream: ReadableStream | null;
  upstreamStatusCode: number;
  abuseServiceUrl: string;
  abuseSecrets: AbuseServiceSecrets | undefined;
  abuseRequestId: number | undefined;
  isStreaming: boolean;
  requestStartedAt: number;
  provider: string;
  providerApiUrl: string;
  providerApiKey: string;
  providerHasGenerationEndpoint: boolean;
  resolvedModel: string;
  requestBody: OpenRouterChatCompletionRequest;
  user: BgUser;
  organizationId: string | undefined;
  modeHeader: string | null;
  fraudHeaders: FraudDetectionHeaders;
  projectId: string | null;
  editorName: string | null;
  machineId: string | null;
  feature: FeatureValue | null;
  autoModel: string | null;
  botId: string | undefined;
  tokenSource: string | undefined;
  userByok: boolean;
  isAnon: boolean;
  sessionId: string | null;
  ttfbMs: number;
  toolsUsed: ReturnType<typeof getToolsUsed>;
  posthogApiKey: string | undefined;
  connectionString: string;
  o11y: { ingestApiMetrics(params: ApiMetricsParams): Promise<void> };
  queue: Queue<BackgroundTaskMessage>;
};

export function scheduleBackgroundTasks(
  ctx: { waitUntil(p: Promise<unknown>): void },
  params: BackgroundTaskParams
): void {
  const {
    accountingStream,
    metricsStream,
    loggingStream,
    upstreamStatusCode,
    abuseRequestId,
    isStreaming,
    requestStartedAt,
    provider,
    providerApiUrl,
    providerHasGenerationEndpoint,
    resolvedModel,
    requestBody,
    user,
    organizationId,
    modeHeader,
    fraudHeaders,
    projectId,
    editorName,
    machineId,
    feature,
    autoModel,
    botId,
    tokenSource,
    userByok,
    isAnon,
    sessionId,
    ttfbMs,
    toolsUsed,
    posthogApiKey,
    connectionString,
    o11y,
    queue,
  } = params;

  // ── Parse accounting stream + enqueue usage accounting ─────────────────────
  const usageParseAndEnqueueTask: Promise<void> =
    accountingStream && !isAnon
      ? withTimeout(
          (async () => {
            let usageStats: MicrodollarUsageStats;
            try {
              if (isStreaming) {
                usageStats = await parseMicrodollarUsageFromStream(
                  accountingStream,
                  user.id,
                  provider,
                  upstreamStatusCode
                );
              } else {
                const text = await new Response(accountingStream).text();
                usageStats = parseMicrodollarUsageFromString(text, user.id, upstreamStatusCode);
              }
            } catch (err) {
              console.error('[bg] Usage stream parse error', err);
              return;
            }

            const promptInfo = extractPromptInfo(requestBody);
            const { estimatedInputTokens, estimatedOutputTokens } = estimateChatTokens(requestBody);

            const usageContext: Omit<MicrodollarUsageContext, 'providerApiKey'> = {
              kiloUserId: user.id,
              fraudHeaders,
              organizationId,
              provider,
              requested_model: resolvedModel,
              promptInfo,
              max_tokens: requestBody.max_tokens ?? null,
              has_middle_out_transform: requestBody.transforms?.includes('middle-out') ?? false,
              estimatedInputTokens,
              estimatedOutputTokens,
              isStreaming,
              prior_microdollar_usage: user.microdollars_used ?? 0,
              posthog_distinct_id: user.google_user_email,
              posthogApiKey,
              providerApiUrl,
              providerHasGenerationEndpoint,
              project_id: projectId,
              status_code: upstreamStatusCode,
              editor_name: editorName,
              machine_id: machineId,
              user_byok: userByok,
              has_tools: Array.isArray(requestBody.tools) && requestBody.tools.length > 0,
              botId,
              tokenSource,
              abuse_request_id: abuseRequestId,
              feature,
              session_id: sessionId,
              mode: modeHeader,
              auto_model: autoModel,
            };

            try {
              await queue.send({
                type: 'usage-accounting',
                idempotencyKey: crypto.randomUUID(),
                usageStats,
                usageContext,
                abuseRequestId,
                fraudHeaders,
                requested_model: resolvedModel,
                kiloUserId: user.id,
                providerId: provider,
              });
            } catch (err) {
              console.error('[bg] Failed to enqueue usage-accounting', err);
            }
          })(),
          BACKGROUND_TASK_TIMEOUT_MS
        )
      : (accountingStream?.cancel(), Promise.resolve());

  // ── Parse metrics stream + enqueue API metrics ─────────────────────────────
  const metricsParseAndEnqueueTask: Promise<void> =
    metricsStream && o11y
      ? withTimeout(
          (async () => {
            let inferenceProvider: string | undefined;
            try {
              inferenceProvider = await drainResponseBodyForInferenceProvider(
                new Response(metricsStream, {
                  headers: {
                    'content-type': isStreaming ? 'text/event-stream' : 'application/json',
                  },
                }),
                60_000
              );
            } catch {
              /* ignore drain errors — still emit timing */
            }

            const completeRequestMs = Math.max(0, Math.round(performance.now() - requestStartedAt));

            const metricsParams: ApiMetricsParams = {
              kiloUserId: user.id,
              organizationId,
              isAnonymous: isAnon,
              isStreaming,
              userByok,
              mode: modeHeader ?? undefined,
              provider,
              requestedModel: autoModel ?? resolvedModel,
              resolvedModel: normalizeModelId(resolvedModel),
              toolsAvailable: getToolsAvailable(requestBody.tools),
              toolsUsed,
              ttfbMs,
              statusCode: upstreamStatusCode,
              inferenceProvider,
              completeRequestMs,
            };

            try {
              await queue.send({
                type: 'api-metrics',
                idempotencyKey: crypto.randomUUID(),
                params: metricsParams,
              });
            } catch (err) {
              console.error('[bg] Failed to enqueue api-metrics', err);
            }
          })(),
          BACKGROUND_TASK_TIMEOUT_MS
        )
      : (metricsStream?.cancel(), Promise.resolve());

  // ── Request logging (Kilo employees only — stays in-process) ───────────────
  const loggingTask =
    loggingStream && !isAnon
      ? withTimeout(
          (async () => {
            const db = getWorkerDb(connectionString);
            await runRequestLogging({
              db,
              responseStream: loggingStream,
              statusCode: upstreamStatusCode,
              user: { id: user.id, google_user_email: user.google_user_email },
              organizationId,
              provider,
              model: resolvedModel,
              request: requestBody,
            });
          })(),
          BACKGROUND_TASK_TIMEOUT_MS
        )
      : (loggingStream?.cancel(), Promise.resolve(undefined));

  ctx.waitUntil(
    Promise.all([usageParseAndEnqueueTask, metricsParseAndEnqueueTask, loggingTask]).catch(err => {
      console.error('[proxy] Background task error', err);
    })
  );
}
