// Background task: parse response stream for token usage, insert microdollar_usage,
// update balances, and track org per-user daily limits.
// Port of src/lib/processUsage.ts — simplified:
//   - No Sentry spans/captures (use console.error/warn)
//   - No PostHog first-usage events
//   - No KiloPass threshold check
//   - Uses crypto.randomUUID() (Web Crypto global) instead of Node `randomUUID`
//   - Uses scheduler.wait() instead of setTimeout for CF Workers backoff

import { createParser } from 'eventsource-parser';
import type { EventSourceMessage } from 'eventsource-parser';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import { organizations, organization_user_usage } from '@kilocode/db/schema';
import type { FraudDetectionHeaders } from '../lib/extract-headers';
import type { FeatureValue } from '../lib/feature-detection';
import type { PromptInfo } from '../lib/prompt-info';
import { isFreeModel } from '../lib/models';
import { isActiveReviewPromo, isActiveCloudAgentPromo } from '../lib/promotions';
import {
  getEffectiveKiloPassThreshold,
  maybeIssueKiloPassBonusFromUsageThreshold,
} from './kilo-pass';

// ─── Types ───────────────────────────────────────────────────────────────────

export type OpenRouterGeneration = {
  data: {
    id: string;
    is_byok?: boolean | null;
    total_cost: number;
    upstream_inference_cost?: number | null;
    created_at: string;
    model: string;
    origin: string;
    usage: number;
    upstream_id?: string | null;
    cache_discount?: number | null;
    app_id?: number | null;
    streamed?: boolean | null;
    cancelled?: boolean | null;
    provider_name?: string | null;
    latency?: number | null;
    moderation_latency?: number | null;
    generation_time?: number | null;
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    tokens_prompt?: number | null;
    tokens_completion?: number | null;
    native_tokens_prompt?: number | null;
    native_tokens_completion?: number | null;
    native_tokens_reasoning?: number | null;
    native_tokens_cached?: number | null;
    num_media_prompt?: number | null;
    num_media_completion?: number | null;
    num_search_results?: number | null;
  };
};

export type OpenRouterUsage = {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost: number };
  completion_tokens: number;
  completion_tokens_details: { reasoning_tokens: number };
  prompt_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  total_tokens: number;
};

type MaybeHasOpenRouterUsage = {
  usage?: OpenRouterUsage | null;
  provider?: string | null;
};

type VercelProviderMetaData = { gateway?: { routing?: { finalProvider?: string } } };

type MaybeHasVercelProviderMetaDataChunk = {
  choices?: {
    delta?: { provider_metadata?: VercelProviderMetaData; content?: string | null };
    message?: { provider_metadata?: VercelProviderMetaData; content?: string | null };
    finish_reason?: string | null;
  }[];
};

type ChatCompletionChunk = MaybeHasOpenRouterUsage &
  MaybeHasVercelProviderMetaDataChunk & {
    id?: string | null;
    model?: string | null;
    error?: unknown;
  };

export type MicrodollarUsageContext = {
  kiloUserId: string;
  fraudHeaders: FraudDetectionHeaders;
  organizationId?: string;
  /** ProviderId string */
  provider: string;
  requested_model: string;
  promptInfo: PromptInfo;
  max_tokens: number | null;
  has_middle_out_transform: boolean | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  isStreaming: boolean;
  /** User's microdollars_used before this request (for first-usage detection). */
  prior_microdollar_usage: number;
  /** User email for authenticated users — used as PostHog distinctId. Undefined for anonymous users. */
  posthog_distinct_id?: string;
  /** PostHog API key for first-usage event capture. Undefined when not configured. */
  posthogApiKey?: string;
  /** Provider base URL — used to call the /generation endpoint for accurate cost data. */
  providerApiUrl: string;
  /** Provider API key — used to authenticate /generation endpoint requests. */
  providerApiKey: string;
  /** Whether the provider supports the /generation?id= endpoint for post-stream cost lookup. */
  providerHasGenerationEndpoint: boolean;
  project_id: string | null;
  status_code: number | null;
  editor_name: string | null;
  machine_id: string | null;
  user_byok: boolean;
  has_tools: boolean;
  botId?: string;
  tokenSource?: string;
  /** Request ID from abuse service classify response; 0 means skip. */
  abuse_request_id?: number;
  feature: FeatureValue | null;
  session_id: string | null;
  mode: string | null;
  auto_model: string | null;
};

type NotYetCostedUsageStats = {
  messageId: string | null;
  model: string | null;
  responseContent: string;
  hasError: boolean;
  inference_provider: string | null;
  upstream_id: string | null;
  finish_reason: string | null;
  latency: number | null;
  moderation_latency: number | null;
  generation_time: number | null;
  streamed: boolean | null;
  cancelled: boolean | null;
};

type JustTheCostsUsageStats = {
  cost_mUsd: number;
  cacheDiscount_mUsd?: number;
  market_cost?: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheHitTokens: number;
  is_byok: boolean | null;
};

export type MicrodollarUsageStats = NotYetCostedUsageStats & JustTheCostsUsageStats;

type UsageMetaData = {
  id: string;
  message_id: string;
  created_at: string;
  http_x_forwarded_for: string | null;
  geo_city: string | null;
  geo_country: string | null;
  geo_latitude: number | null;
  geo_longitude: number | null;
  ja3_hash: string | null;
  user_prompt_prefix: string | null;
  system_prompt_prefix: string | null;
  system_prompt_length: number | null;
  http_user_agent: string | null;
  max_tokens: number | null;
  has_middle_out_transform: boolean | null;
  status_code: number | null;
  upstream_id: string | null;
  finish_reason: string | null;
  latency: number | null;
  moderation_latency: number | null;
  generation_time: number | null;
  is_byok: boolean | null;
  is_user_byok: boolean;
  streamed: boolean | null;
  cancelled: boolean | null;
  editor_name: string | null;
  has_tools: boolean | null;
  machine_id: string | null;
  feature: string | null;
  session_id: string | null;
  mode: string | null;
  auto_model: string | null;
  market_cost: number | null;
};

type CoreUsageFields = {
  id: string;
  kilo_user_id: string;
  organization_id: string | null;
  provider: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_hit_tokens: number;
  created_at: string;
  model: string | null;
  requested_model: string;
  cache_discount: number | null;
  has_error: boolean;
  abuse_classification: number;
  inference_provider: string | null;
  project_id: string | null;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toMicrodollars(usd: number): number {
  return Math.round(usd * 1_000_000);
}

// For BYOK, OpenRouter only reports 5% of the actual cost.
const OPENROUTER_BYOK_COST_MULTIPLIER = 20.0;

function processOpenRouterUsage(
  usage: OpenRouterUsage | null | undefined,
  coreProps: NotYetCostedUsageStats
): JustTheCostsUsageStats {
  const is_byok = usage?.is_byok ?? null;
  const openrouterCost_USD = usage?.cost ?? 0;
  const upstream_inference_cost_USD = usage?.cost_details?.upstream_inference_cost ?? 0;
  const cost_mUsd = toMicrodollars(is_byok ? upstream_inference_cost_USD : openrouterCost_USD);
  const inferredUpstream_USD = openrouterCost_USD * OPENROUTER_BYOK_COST_MULTIPLIER;
  const microdollar_error = (inferredUpstream_USD - upstream_inference_cost_USD) * 1000000;

  if (
    (is_byok == null && (openrouterCost_USD || upstream_inference_cost_USD)) ||
    (is_byok && usage?.cost !== 0 && 1.1 < Math.abs(microdollar_error))
  ) {
    const { responseContent: _ignore, ...logProps } = coreProps;
    console.warn("SUSPICIOUS: openrouter's cost accounting doesn't make sense", {
      ...logProps,
      cost_mUsd,
      is_byok,
      openrouterCost_USD,
      upstream_inference_cost_USD,
    });
  }

  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    cacheHitTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cost_mUsd,
    is_byok,
  };
}

// ─── Generation endpoint refetch ─────────────────────────────────────────────

// Fetch generation data from the provider's /generation?id= endpoint.
// Uses exponential backoff because OpenRouter may return 404 if called too soon after streaming.
async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  shouldRetry: (r: Response) => boolean
): Promise<Response> {
  const maxElapsedMs = 20_000;
  const startedAt = Date.now();
  let nextDelayMs = 200 * (1 + (Math.random() - 0.5) / 10);
  while (true) {
    const response = await fetch(url, init);
    if (!shouldRetry(response)) return response;
    if (Date.now() - startedAt + nextDelayMs > maxElapsedMs) return response;
    await scheduler.wait(nextDelayMs);
    nextDelayMs = nextDelayMs * 1.5;
  }
}

async function fetchGeneration(
  apiUrl: string,
  apiKey: string,
  messageId: string
): Promise<OpenRouterGeneration | null> {
  // Delay 200ms — the provider may not have the cost ready immediately after streaming.
  await scheduler.wait(200);
  try {
    const response = await fetchWithBackoff(
      `${apiUrl}/generation?id=${messageId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://kilocode.ai',
          'X-Title': 'Kilo Code',
        },
      },
      r => r.status >= 400 // retry on 404 (generation not yet available)
    );
    if (!response.ok) {
      console.warn('fetchGeneration: non-ok response', {
        status: response.status,
        messageId,
      });
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn('fetchGeneration: fetch error', { messageId, err });
    return null;
  }
}

export function mapToUsageStats(
  generation: OpenRouterGeneration,
  responseContent: string
): MicrodollarUsageStats {
  const { data } = generation;
  let llmCostUsd: number;
  if (!data.is_byok) {
    llmCostUsd = data.total_cost;
  } else if (data.upstream_inference_cost == null) {
    console.warn('SUSPICIOUS: openrouter missing upstream_inference_cost', { id: data.id });
    llmCostUsd = data.total_cost * OPENROUTER_BYOK_COST_MULTIPLIER;
  } else {
    llmCostUsd = data.upstream_inference_cost;
  }

  return {
    messageId: data.id,
    hasError: false,
    model: data.model,
    responseContent,
    inputTokens: data.native_tokens_prompt ?? 0,
    cacheHitTokens: data.native_tokens_cached ?? 0,
    cacheWriteTokens: 0,
    outputTokens: data.native_tokens_completion ?? 0,
    cost_mUsd: toMicrodollars(llmCostUsd),
    is_byok: data.is_byok ?? null,
    cacheDiscount_mUsd:
      data.cache_discount == null ? undefined : toMicrodollars(data.cache_discount),
    inference_provider: data.provider_name ?? null,
    upstream_id: data.upstream_id ?? null,
    finish_reason: data.finish_reason ?? null,
    latency: data.latency ?? null,
    moderation_latency: data.moderation_latency ?? null,
    generation_time: data.generation_time ?? null,
    streamed: data.streamed ?? null,
    cancelled: data.cancelled ?? null,
  };
}

// ─── Stream/string parsers ────────────────────────────────────────────────────

export async function parseMicrodollarUsageFromStream(
  stream: ReadableStream<Uint8Array>,
  kiloUserId: string,
  provider: string,
  statusCode: number
): Promise<MicrodollarUsageStats> {
  let messageId: string | null = null;
  let model: string | null = null;
  let responseContent = '';
  let reportedError = statusCode >= 400;
  let usage: OpenRouterUsage | null = null;
  let inference_provider: string | null = null;
  let finish_reason: string | null = null;

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const sseStreamParser = createParser({
    onEvent(event: EventSourceMessage) {
      if (event.data === '[DONE]') return;

      let json: ChatCompletionChunk | undefined;
      try {
        json = JSON.parse(event.data) as ChatCompletionChunk;
      } catch {
        return;
      }

      if (!json) return;

      if ('error' in json) {
        reportedError = true;
        console.warn('OpenRouter error in SSE stream', { error: json.error, kiloUserId, provider });
      }

      model = json.model ?? model;
      messageId = json.id ?? messageId;
      usage = json.usage ?? usage;
      const choice = json.choices?.[0];
      inference_provider =
        json.provider ??
        choice?.delta?.provider_metadata?.gateway?.routing?.finalProvider ??
        inference_provider;
      finish_reason = choice?.finish_reason ?? finish_reason;

      const contentDelta = choice?.delta?.content;
      if (typeof contentDelta === 'string') {
        responseContent += contentDelta;
      }
    },
  });

  let wasAborted = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseStreamParser.feed(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'ResponseAborted') {
      wasAborted = true;
    } else {
      throw error;
    }
  } finally {
    reader.releaseLock();
  }

  if (!reportedError && !usage) {
    console.warn('SUSPICIOUS: No usage chunk in stream', {
      kiloUserId,
      provider,
      messageId,
      model,
    });
  }

  const coreProps: NotYetCostedUsageStats = {
    messageId,
    hasError: reportedError || wasAborted,
    model,
    responseContent,
    inference_provider,
    finish_reason,
    upstream_id: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: true,
    cancelled: null,
  };

  return { ...coreProps, ...processOpenRouterUsage(usage, coreProps) };
}

type NonStreamingResponseJson = {
  id?: string | null;
  model?: string | null;
  provider?: string | null;
  usage?: OpenRouterUsage | null;
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      provider_metadata?: VercelProviderMetaData;
    };
  }[];
};

export function parseMicrodollarUsageFromString(
  fullResponse: string,
  kiloUserId: string,
  statusCode: number
): MicrodollarUsageStats {
  let responseJson: NonStreamingResponseJson | null = null;

  try {
    responseJson = JSON.parse(fullResponse) as NonStreamingResponseJson;
  } catch {
    console.warn('parseMicrodollarUsageFromString: failed to parse JSON', { kiloUserId });
  }

  if (responseJson?.usage?.is_byok == null && responseJson?.usage?.cost) {
    console.warn('SUSPICIOUS: is_byok is null', { kiloUserId });
  }

  const choice = responseJson?.choices?.[0];
  const coreProps: NotYetCostedUsageStats = {
    messageId: responseJson?.id ?? null,
    hasError: !responseJson?.model || statusCode >= 400,
    model: responseJson?.model ?? null,
    responseContent: choice?.message?.content ?? '',
    inference_provider:
      responseJson?.provider ??
      choice?.message?.provider_metadata?.gateway?.routing?.finalProvider ??
      null,
    upstream_id: null,
    finish_reason: choice?.finish_reason ?? null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled: null,
  };

  return { ...coreProps, ...processOpenRouterUsage(responseJson?.usage, coreProps) };
}

// ─── DB insertion ─────────────────────────────────────────────────────────────

/**
 * CTE fragment that upserts a value into a small lookup table.
 * Returns CTEs: `{name}_value`, `{name}_existing`, `{name}_ins`, `{name}_cte`
 * containing the ID of the (possibly newly inserted) row.
 */
function createUpsertCTE(metaDataKindName: ReturnType<typeof sql>, value: string | null) {
  return sql`
${metaDataKindName}_value AS (
  SELECT value
  FROM (VALUES (${value})) v(value)
  WHERE value IS NOT NULL
),
${metaDataKindName}_existing AS (
  SELECT ${metaDataKindName}_id
  FROM ${metaDataKindName}, ${metaDataKindName}_value
  WHERE ${metaDataKindName}.${metaDataKindName} = ${metaDataKindName}_value.value
),
${metaDataKindName}_ins AS (
  INSERT INTO ${metaDataKindName} (${metaDataKindName})
  SELECT ${metaDataKindName}_value.value FROM ${metaDataKindName}_value
  WHERE NOT EXISTS (SELECT 1 FROM ${metaDataKindName}_existing)
  ON CONFLICT (${metaDataKindName}) DO UPDATE SET ${metaDataKindName} = EXCLUDED.${metaDataKindName}
  RETURNING ${metaDataKindName}_id
),
${metaDataKindName}_cte AS (
  SELECT ${metaDataKindName}_id FROM ${metaDataKindName}_existing
  UNION ALL
  SELECT ${metaDataKindName}_id FROM ${metaDataKindName}_ins
)`;
}

async function insertUsageAndMetadataWithBalanceUpdate(
  db: WorkerDb,
  coreUsageFields: CoreUsageFields,
  metadataFields: UsageMetaData
): Promise<{ newMicrodollarsUsed: number; kiloPassThreshold: number | null } | null> {
  const result = await db.execute<{
    new_microdollars_used: number | bigint | string;
    kilo_pass_threshold: number | bigint | string | null;
  }>(sql`
    WITH microdollar_usage_ins AS (
      INSERT INTO microdollar_usage (
        id, kilo_user_id, organization_id, provider, cost,
        input_tokens, output_tokens, cache_write_tokens, cache_hit_tokens,
        created_at, model, requested_model, cache_discount, has_error, abuse_classification,
        inference_provider, project_id
      ) VALUES (
        ${coreUsageFields.id},
        ${coreUsageFields.kilo_user_id},
        ${coreUsageFields.organization_id},
        ${coreUsageFields.provider},
        ${coreUsageFields.cost},
        ${coreUsageFields.input_tokens},
        ${coreUsageFields.output_tokens},
        ${coreUsageFields.cache_write_tokens},
        ${coreUsageFields.cache_hit_tokens},
        ${coreUsageFields.created_at},
        ${coreUsageFields.model},
        ${coreUsageFields.requested_model},
        ${coreUsageFields.cache_discount},
        ${coreUsageFields.has_error},
        ${coreUsageFields.abuse_classification},
        ${coreUsageFields.inference_provider},
        ${coreUsageFields.project_id}
      )
    )
    , ${createUpsertCTE(sql`http_user_agent`, metadataFields.http_user_agent)}
    , ${createUpsertCTE(sql`http_ip`, metadataFields.http_x_forwarded_for)}
    , ${createUpsertCTE(sql`vercel_ip_country`, metadataFields.geo_country)}
    , ${createUpsertCTE(sql`vercel_ip_city`, metadataFields.geo_city)}
    , ${createUpsertCTE(sql`ja4_digest`, metadataFields.ja3_hash)}
    , ${createUpsertCTE(sql`system_prompt_prefix`, metadataFields.system_prompt_prefix)}
    , ${createUpsertCTE(sql`finish_reason`, metadataFields.finish_reason)}
    , ${createUpsertCTE(sql`editor_name`, metadataFields.editor_name)}
    , ${createUpsertCTE(sql`feature`, metadataFields.feature)}
    , ${createUpsertCTE(sql`mode`, metadataFields.mode)}
    , ${createUpsertCTE(sql`auto_model`, metadataFields.auto_model)}
    , metadata_ins AS (
      INSERT INTO microdollar_usage_metadata (
        id,
        message_id,
        created_at,
        user_prompt_prefix,
        vercel_ip_latitude,
        vercel_ip_longitude,
        system_prompt_length,
        max_tokens,
        has_middle_out_transform,
        status_code,
        upstream_id,
        latency,
        moderation_latency,
        generation_time,
        is_byok,
        is_user_byok,
        streamed,
        cancelled,
        has_tools,
        machine_id,
        session_id,
        market_cost,

        http_user_agent_id,
        http_ip_id,
        vercel_ip_country_id,
        vercel_ip_city_id,
        ja4_digest_id,
        system_prompt_prefix_id,
        finish_reason_id,
        editor_name_id,
        feature_id,
        mode_id,
        auto_model_id
      )
      SELECT
        ${metadataFields.id},
        ${metadataFields.message_id},
        ${metadataFields.created_at},
        ${metadataFields.user_prompt_prefix},
        ${metadataFields.geo_latitude},
        ${metadataFields.geo_longitude},
        ${metadataFields.system_prompt_length},
        ${metadataFields.max_tokens},
        ${metadataFields.has_middle_out_transform},
        ${metadataFields.status_code},
        ${metadataFields.upstream_id},
        ${metadataFields.latency},
        ${metadataFields.moderation_latency},
        ${metadataFields.generation_time},
        ${metadataFields.is_byok},
        ${metadataFields.is_user_byok},
        ${metadataFields.streamed},
        ${metadataFields.cancelled},
        ${metadataFields.has_tools},
        ${metadataFields.machine_id},
        ${metadataFields.session_id},
        ${metadataFields.market_cost},

        (SELECT http_user_agent_id FROM http_user_agent_cte),
        (SELECT http_ip_id FROM http_ip_cte),
        (SELECT vercel_ip_country_id FROM vercel_ip_country_cte),
        (SELECT vercel_ip_city_id FROM vercel_ip_city_cte),
        (SELECT ja4_digest_id FROM ja4_digest_cte),
        (SELECT system_prompt_prefix_id FROM system_prompt_prefix_cte),
        (SELECT finish_reason_id FROM finish_reason_cte),
        (SELECT editor_name_id FROM editor_name_cte),
        (SELECT feature_id FROM feature_cte),
        (SELECT mode_id FROM mode_cte),
        (SELECT auto_model_id FROM auto_model_cte)
    )
    UPDATE kilocode_users
    SET microdollars_used = microdollars_used + ${coreUsageFields.cost}
    WHERE id = ${coreUsageFields.kilo_user_id}
      AND ${coreUsageFields.organization_id}::uuid IS NULL
      AND ${coreUsageFields.cost} > 0
    RETURNING microdollars_used AS new_microdollars_used, kilo_pass_threshold
  `);

  if (!result.rows[0]) {
    if (!coreUsageFields.organization_id && coreUsageFields.cost && coreUsageFields.cost > 0) {
      console.error('impossible: missing user in balance update', {
        kilo_user_id: coreUsageFields.kilo_user_id,
        cost: coreUsageFields.cost,
      });
    }
    return null;
  }

  const newMicrodollarsUsed = Number(result.rows[0].new_microdollars_used);
  const kiloPassThreshold =
    result.rows[0].kilo_pass_threshold == null ? null : Number(result.rows[0].kilo_pass_threshold);

  return { newMicrodollarsUsed, kiloPassThreshold };
}

async function ingestOrganizationTokenUsage(
  db: WorkerDb,
  usage: { cost: number; kilo_user_id: string; organization_id: string | null }
): Promise<void> {
  if (!usage.organization_id) return;
  const orgId = usage.organization_id;

  await db.transaction(async tx => {
    await tx
      .update(organizations)
      .set({
        microdollars_used: sql`${organizations.microdollars_used} + ${usage.cost}`,
        microdollars_balance: sql`${organizations.microdollars_balance} - ${usage.cost}`,
      })
      .where(eq(organizations.id, orgId));

    await tx.execute(sql`
      INSERT INTO ${organization_user_usage} (
        organization_id,
        kilo_user_id,
        usage_date,
        limit_type,
        microdollar_usage,
        created_at,
        updated_at
      )
      SELECT
        ${usage.organization_id},
        ${usage.kilo_user_id},
        CURRENT_DATE,
        ${'daily'},
        ${usage.cost},
        NOW(),
        NOW()
      ON CONFLICT (organization_id, kilo_user_id, limit_type, usage_date)
      DO UPDATE SET
        microdollar_usage = ${organization_user_usage.microdollar_usage} + ${usage.cost},
        updated_at = NOW()
    `);
  });
}

// ─── PostHog first-usage events ───────────────────────────────────────────────

const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/capture';

async function sendPostHogEvent(
  apiKey: string,
  distinctId: string,
  event: string,
  properties: Record<string, unknown>
): Promise<void> {
  try {
    await fetch(POSTHOG_CAPTURE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, distinct_id: distinctId, event, properties }),
    });
  } catch (err) {
    console.warn(`[posthog] Failed to send ${event} event`, err);
  }
}

async function isFirstUsageEver(
  db: WorkerDb,
  kiloUserId: string,
  priorMicrodollarUsage: number,
  organizationId: string | undefined
): Promise<boolean> {
  if (priorMicrodollarUsage > 0 || organizationId) return false;
  // Check if there are any prior usage records for this user
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM microdollar_usage WHERE kilo_user_id = ${kiloUserId} LIMIT 1
    ) AS exists
  `);
  return !result.rows[0]?.exists;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Parse usage from the background response stream, build the DB record, and insert.
 * Returns the MicrodollarUsageStats (including inference_provider and messageId) for
 * downstream use by api-metrics and abuse-cost background tasks.
 */
export async function runUsageAccounting(
  stream: ReadableStream<Uint8Array> | null,
  usageContext: MicrodollarUsageContext,
  db: WorkerDb
): Promise<MicrodollarUsageStats | null> {
  if (!stream) {
    console.warn('runUsageAccounting: no stream provided', {
      kiloUserId: usageContext.kiloUserId,
    });
    return null;
  }

  let usageStats: MicrodollarUsageStats;
  try {
    if (usageContext.isStreaming) {
      usageStats = await parseMicrodollarUsageFromStream(
        stream,
        usageContext.kiloUserId,
        usageContext.provider,
        usageContext.status_code ?? 200
      );
    } else {
      const text = await new Response(stream).text();
      usageStats = parseMicrodollarUsageFromString(
        text,
        usageContext.kiloUserId,
        usageContext.status_code ?? 200
      );
    }
  } catch (err) {
    console.error('runUsageAccounting: parse error', err);
    return null;
  }

  // Refetch accurate cost/token data from the provider's generation endpoint when available.
  // OpenRouter's /generation?id= gives more precise token counts and cost data than the SSE stream.
  if (usageContext.providerHasGenerationEndpoint && usageStats.messageId && !usageStats.hasError) {
    try {
      const generation = await fetchGeneration(
        usageContext.providerApiUrl,
        usageContext.providerApiKey,
        usageStats.messageId
      );
      if (generation) {
        const genStats = mapToUsageStats(generation, usageStats.responseContent);
        // Preserve stream-derived fields that the generation endpoint may not have.
        genStats.model = usageStats.model;
        genStats.hasError = usageStats.hasError;
        genStats.streamed ??= usageContext.isStreaming;
        if (genStats.cost_mUsd !== usageStats.cost_mUsd) {
          console.warn('DEV ODDITY: usage stats do not match generation data', {
            model: genStats.model,
            gen_cost: genStats.cost_mUsd,
            stream_cost: usageStats.cost_mUsd,
          });
        }
        usageStats = genStats;
      }
    } catch (err) {
      console.warn('runUsageAccounting: fetchGeneration failed', err);
    }
  }

  // Use requested_model as model fallback
  if (!usageStats.model) {
    usageStats.model = usageContext.requested_model;
  }

  // Preserve the real cost before zeroing for free/BYOK/promo
  usageStats.market_cost = usageStats.cost_mUsd;

  // Zero out cost for free/BYOK/promo requests
  if (
    isFreeModel(usageContext.requested_model) ||
    usageContext.user_byok ||
    isActiveReviewPromo(usageContext.botId, usageContext.requested_model) ||
    isActiveCloudAgentPromo(usageContext.tokenSource, usageContext.requested_model)
  ) {
    usageStats.cost_mUsd = 0;
    usageStats.cacheDiscount_mUsd = 0;
  }

  // Build DB records
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();

  const coreUsageFields: CoreUsageFields = {
    id,
    kilo_user_id: usageContext.kiloUserId,
    organization_id: usageContext.organizationId ?? null,
    provider: usageContext.provider,
    cost: usageStats.cost_mUsd,
    input_tokens: usageStats.inputTokens,
    output_tokens: usageStats.outputTokens,
    cache_write_tokens: usageStats.cacheWriteTokens,
    cache_hit_tokens: usageStats.cacheHitTokens,
    created_at,
    model: usageStats.model,
    requested_model: usageContext.requested_model,
    cache_discount: usageStats.cacheDiscount_mUsd ?? null,
    has_error: usageStats.hasError,
    abuse_classification: 0,
    inference_provider: usageStats.inference_provider,
    project_id: usageContext.project_id,
  };

  let system_prompt_prefix: string | null = usageContext.promptInfo.system_prompt_prefix;
  let user_prompt_prefix: string | null = usageContext.promptInfo.user_prompt_prefix;

  // Never log sensitive data for org requests
  if (usageContext.organizationId) {
    system_prompt_prefix = '';
    user_prompt_prefix = null;
  }

  const metadataFields: UsageMetaData = {
    id,
    created_at,
    message_id: usageStats.messageId ?? '<missing>',
    http_x_forwarded_for: usageContext.fraudHeaders.http_x_forwarded_for,
    geo_city: usageContext.fraudHeaders.geo_city,
    geo_country: usageContext.fraudHeaders.geo_country,
    geo_latitude: usageContext.fraudHeaders.geo_latitude,
    geo_longitude: usageContext.fraudHeaders.geo_longitude,
    ja3_hash: usageContext.fraudHeaders.ja3_hash,
    user_prompt_prefix: user_prompt_prefix ?? null,
    system_prompt_prefix: system_prompt_prefix || null,
    system_prompt_length: usageContext.promptInfo.system_prompt_length,
    http_user_agent: usageContext.fraudHeaders.http_user_agent,
    max_tokens: usageContext.max_tokens,
    has_middle_out_transform: usageContext.has_middle_out_transform,
    status_code: usageContext.status_code,
    upstream_id: usageStats.upstream_id,
    finish_reason: usageStats.finish_reason,
    latency: usageStats.latency,
    moderation_latency: usageStats.moderation_latency,
    generation_time: usageStats.generation_time,
    is_byok: usageStats.is_byok,
    is_user_byok: usageContext.user_byok,
    streamed: usageStats.streamed,
    cancelled: usageStats.cancelled,
    editor_name: usageContext.editor_name,
    has_tools: usageContext.has_tools,
    machine_id: usageContext.machine_id,
    feature: usageContext.feature,
    session_id: usageContext.session_id,
    mode: usageContext.mode,
    auto_model: usageContext.auto_model,
    market_cost: usageStats.market_cost ?? null,
  };

  let balanceUpdateResult: {
    newMicrodollarsUsed: number;
    kiloPassThreshold: number | null;
  } | null = null;
  try {
    let attempt = 0;
    while (true) {
      try {
        balanceUpdateResult = await insertUsageAndMetadataWithBalanceUpdate(
          db,
          coreUsageFields,
          metadataFields
        );
        break;
      } catch (err) {
        if (attempt >= 2) throw err;
        console.warn('insertUsageRecord concurrency failure, retrying', { attempt });
        await scheduler.wait(Math.random() * 100);
        attempt++;
      }
    }
  } catch (err) {
    console.error('insertUsageRecord failed', err);
    // Don't return null — we still want to return stats for abuse cost reporting
  }

  // KiloPass: trigger bonus credit issuance if usage threshold is crossed.
  if (balanceUpdateResult) {
    const effectiveThreshold = getEffectiveKiloPassThreshold(balanceUpdateResult.kiloPassThreshold);
    if (
      effectiveThreshold !== null &&
      balanceUpdateResult.newMicrodollarsUsed >= effectiveThreshold
    ) {
      // Fire async — do not await; errors are logged inside.
      void maybeIssueKiloPassBonusFromUsageThreshold(
        db,
        coreUsageFields.kilo_user_id,
        coreUsageFields.created_at
      ).catch(err => {
        console.error('[kilo-pass] maybeIssueKiloPassBonusFromUsageThreshold failed', err);
      });
    }
  }

  try {
    await ingestOrganizationTokenUsage(db, {
      cost: coreUsageFields.cost,
      kilo_user_id: coreUsageFields.kilo_user_id,
      organization_id: coreUsageFields.organization_id,
    });
  } catch (err) {
    console.error('ingestOrganizationTokenUsage failed', err);
  }

  // PostHog first-usage events (authenticated non-org users only)
  if (usageContext.posthog_distinct_id && usageContext.posthogApiKey) {
    const apiKey = usageContext.posthogApiKey;
    const distinctId = usageContext.posthog_distinct_id;

    try {
      const isFirst = await isFirstUsageEver(
        db,
        coreUsageFields.kilo_user_id,
        usageContext.prior_microdollar_usage,
        usageContext.organizationId
      );
      if (isFirst) {
        await sendPostHogEvent(apiKey, distinctId, 'first_usage', {
          model: usageStats.model,
          cost_mUsd: coreUsageFields.cost,
        });
        console.log('first_usage PostHog event sent');
      }
    } catch (err) {
      console.warn('[posthog] first_usage check failed', err);
    }

    // first_microdollar_usage: fires the first time the user crosses the 1 microdollar threshold
    if (balanceUpdateResult) {
      const priorUsageAtEnd = Math.abs(
        balanceUpdateResult.newMicrodollarsUsed - coreUsageFields.cost
      );
      if (priorUsageAtEnd < 1) {
        try {
          await sendPostHogEvent(apiKey, distinctId, 'first_microdollar_usage', {
            model: usageStats.model,
            cost_mUsd: coreUsageFields.cost,
          });
        } catch (err) {
          console.warn('[posthog] first_microdollar_usage send failed', err);
        }
      }
    }
  }

  return usageStats;
}
