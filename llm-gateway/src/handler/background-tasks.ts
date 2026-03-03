// Background tasks scheduled via ctx.waitUntil() after the client response is sent.
// Handles usage accounting, API metrics, request logging, and abuse cost reporting.

import { getWorkerDb } from '@kilocode/db/client';
import {
  runUsageAccounting,
  type MicrodollarUsageContext,
  type MicrodollarUsageStats,
} from '../background/usage-accounting';
import { runApiMetrics } from '../background/api-metrics';
import { runRequestLogging } from '../background/request-logging';
import { reportAbuseCost, type AbuseServiceSecrets } from '../lib/abuse-service';
import { extractPromptInfo, estimateChatTokens } from '../lib/prompt-info';
import { getToolsAvailable, getToolsUsed } from '../background/api-metrics';
import type { FraudDetectionHeaders } from '../lib/extract-headers';
import type { FeatureValue } from '../lib/feature-detection';
import type { OpenRouterChatCompletionRequest } from '../types/request';
import type { ApiMetricsParams } from '@kilocode/worker-utils';

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
  accountingStream: ReadableStream | null;
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
    abuseServiceUrl,
    abuseSecrets,
    abuseRequestId,
    isStreaming,
    requestStartedAt,
    provider,
    providerApiUrl,
    providerApiKey,
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
  } = params;

  // ── Usage accounting ───────────────────────────────────────────────────────
  const usageTask: Promise<MicrodollarUsageStats | null | undefined> =
    accountingStream && !isAnon
      ? withTimeout(
          (async () => {
            const db = getWorkerDb(connectionString);
            const promptInfo = extractPromptInfo(requestBody);
            const { estimatedInputTokens, estimatedOutputTokens } = estimateChatTokens(requestBody);

            const usageContext: MicrodollarUsageContext = {
              kiloUserId: user.id,
              fraudHeaders,
              organizationId,
              provider,
              requested_model: resolvedModel,
              promptInfo,
              max_tokens: requestBody.max_tokens ?? null,
              has_middle_out_transform: requestBody.transforms?.includes('middle-out') ?? null,
              estimatedInputTokens,
              estimatedOutputTokens,
              isStreaming,
              prior_microdollar_usage: user.microdollars_used ?? 0,
              posthog_distinct_id: user.google_user_email,
              posthogApiKey,
              providerApiUrl,
              providerApiKey,
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

            return runUsageAccounting(accountingStream, usageContext, db);
          })(),
          BACKGROUND_TASK_TIMEOUT_MS
        )
      : (accountingStream?.cancel(), Promise.resolve(null));

  // ── API metrics ────────────────────────────────────────────────────────────
  const metricsTask =
    metricsStream && o11y
      ? withTimeout(
          (async () => {
            await runApiMetrics(
              o11y,
              {
                kiloUserId: user.id,
                organizationId,
                isAnonymous: isAnon,
                isStreaming,
                userByok,
                mode: modeHeader ?? undefined,
                provider,
                requestedModel: requestBody.model ?? resolvedModel,
                resolvedModel,
                toolsAvailable: getToolsAvailable(requestBody.tools),
                toolsUsed,
                ttfbMs,
                statusCode: upstreamStatusCode,
              },
              metricsStream,
              requestStartedAt
            );
          })(),
          BACKGROUND_TASK_TIMEOUT_MS
        )
      : (metricsStream?.cancel(), Promise.resolve(undefined));

  // ── Request logging (Kilo employees only) ──────────────────────────────────
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

  // ── Abuse cost (depends on usage accounting result) ────────────────────────
  const abuseCostTask = withTimeout(
    usageTask.then(usageStats => {
      if (!usageStats || !abuseRequestId) return;
      return reportAbuseCost(
        abuseServiceUrl,
        abuseSecrets,
        {
          kiloUserId: user.id,
          fraudHeaders,
          requested_model: resolvedModel,
          abuse_request_id: abuseRequestId,
        },
        {
          messageId: usageStats.messageId,
          cost_mUsd: usageStats.market_cost ?? usageStats.cost_mUsd,
          inputTokens: usageStats.inputTokens,
          outputTokens: usageStats.outputTokens,
          cacheWriteTokens: usageStats.cacheWriteTokens,
          cacheHitTokens: usageStats.cacheHitTokens,
        }
      );
    }),
    BACKGROUND_TASK_TIMEOUT_MS
  );

  ctx.waitUntil(
    Promise.all([usageTask, metricsTask, loggingTask, abuseCostTask]).catch(err => {
      console.error('[proxy] Background task error', err);
    })
  );
}
