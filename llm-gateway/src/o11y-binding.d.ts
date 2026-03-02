/**
 * Augment the wrangler-generated Env to give the O11Y service binding its RPC
 * method types.  `wrangler types` only sees `Fetcher` for service bindings;
 * the actual RPC shape comes from the o11y worker's WorkerEntrypoint and is
 * declared here so the generated file can be freely regenerated.
 *
 * Keep in sync with: cloudflare-o11y/src/api-metrics-routes.ts (ApiMetricsParamsSchema)
 */

type O11YApiMetricsParams = {
  kiloUserId: string;
  organizationId?: string;
  isAnonymous: boolean;
  isStreaming: boolean;
  userByok: boolean;
  mode?: string;
  provider: string;
  inferenceProvider?: string;
  requestedModel: string;
  resolvedModel: string;
  toolsAvailable: string[];
  toolsUsed: string[];
  ttfbMs: number;
  completeRequestMs: number;
  statusCode: number;
  tokens?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheHitTokens?: number;
    totalTokens?: number;
  };
};

type O11YBinding = Fetcher & {
  ingestApiMetrics(params: O11YApiMetricsParams): Promise<void>;
};
