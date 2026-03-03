// Abuse detection service client — port of src/lib/abuse-service.ts.
// Communicates with the Kilo Abuse Detection Service via Cloudflare Access.

import type { OpenRouterChatCompletionRequest } from '../types/request';
import type { FraudDetectionHeaders } from './extract-headers';

// ─── Public types (mirror the Next.js version for Phase 6 compatibility) ────

export type Verdict = 'ALLOW' | 'CHALLENGE' | 'SOFT_BLOCK' | 'HARD_BLOCK';
export type AbuseSignal =
  | 'high_velocity'
  | 'free_tier_exhausted'
  | 'premium_harvester'
  | 'suspicious_fingerprint'
  | 'datacenter_ip'
  | 'known_abuser';
export type ChallengeType = 'turnstile' | 'payment_verification';
export type ActionMetadata = {
  challenge_type?: ChallengeType;
  model_override?: string;
  retry_after_seconds?: number;
};
export type ClassificationContext = {
  identity_key: string;
  current_spend_1h: number;
  is_new_user: boolean;
  requests_per_second: number;
};
export type AbuseClassificationResponse = {
  verdict: Verdict;
  risk_score: number;
  signals: AbuseSignal[];
  action_metadata: ActionMetadata;
  context: ClassificationContext;
  /** 0 indicates classification error */
  request_id: number;
};

export type UsagePayload = {
  id?: string;
  kilo_user_id?: string | null;
  organization_id?: string | null;
  project_id?: string | null;
  message_id?: string | null;
  cost?: number | null;
  cache_discount?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_write_tokens?: number | null;
  cache_hit_tokens?: number | null;
  ip_address?: string | null;
  geo_city?: string | null;
  geo_country?: string | null;
  geo_latitude?: number | null;
  geo_longitude?: number | null;
  ja4_digest?: string | null;
  user_agent?: string | null;
  provider?: string | null;
  model?: string | null;
  requested_model?: string | null;
  inference_provider?: string | null;
  user_prompt?: string | null;
  system_prompt?: string | null;
  max_tokens?: number | null;
  has_middle_out_transform?: boolean | null;
  has_tools?: boolean | null;
  streamed?: boolean | null;
  status_code?: number | null;
  upstream_id?: string | null;
  finish_reason?: string | null;
  has_error?: boolean | null;
  cancelled?: boolean | null;
  created_at?: string | null;
  latency?: number | null;
  moderation_latency?: number | null;
  generation_time?: number | null;
  is_byok?: boolean | null;
  is_user_byok?: boolean | null;
  editor_name?: string | null;
  abuse_classification?: number | null;
};

export type CostUpdateResponse = {
  success: boolean;
  identity_key?: string;
  message_id?: string;
  do_updated?: boolean;
  error?: string;
};

// ─── Secrets bundle needed for CF Access auth ────────────────────────────────

export type AbuseServiceSecrets = {
  cfAccessClientId: string;
  cfAccessClientSecret: string;
};

// ─── Internal helpers ────────────────────────────────────────────────────────

type Message = { role: string; content?: string | Array<{ type?: string; text?: string }> };

function extractMessageTextContent(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n');
  }
  return '';
}

function extractFullPrompts(body: OpenRouterChatCompletionRequest): {
  systemPrompt: string | null;
  userPrompt: string | null;
} {
  const messages = (body.messages as Message[]) ?? [];
  const systemPrompt =
    messages
      .filter(m => m.role === 'system' || m.role === 'developer')
      .map(extractMessageTextContent)
      .join('\n') || null;
  const userPrompt =
    messages
      .filter(m => m.role === 'user')
      .map(extractMessageTextContent)
      .at(-1) ?? null;
  return { systemPrompt, userPrompt };
}

function buildAccessHeaders(secrets: AbuseServiceSecrets | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secrets) {
    headers['CF-Access-Client-Id'] = secrets.cfAccessClientId;
    headers['CF-Access-Client-Secret'] = secrets.cfAccessClientSecret;
  }
  return headers;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function classifyRequest(
  serviceUrl: string,
  secrets: AbuseServiceSecrets | undefined,
  payload: UsagePayload
): Promise<AbuseClassificationResponse | null> {
  if (!serviceUrl) return null;

  try {
    const response = await fetch(`${serviceUrl}/api/classify`, {
      method: 'POST',
      headers: buildAccessHeaders(secrets),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error(`Abuse service error (${response.status}): ${await response.text()}`);
      return null;
    }
    return (await response.json()) as AbuseClassificationResponse;
  } catch (err) {
    console.error('Abuse classification failed:', err);
    return null;
  }
}

export type AbuseClassificationContext = {
  kiloUserId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  provider?: string | null;
  isByok?: boolean | null;
};

export async function classifyAbuse(
  serviceUrl: string,
  secrets: AbuseServiceSecrets | undefined,
  fraudHeaders: FraudDetectionHeaders,
  editorName: string | null,
  body: OpenRouterChatCompletionRequest,
  context?: AbuseClassificationContext
): Promise<AbuseClassificationResponse | null> {
  const { systemPrompt, userPrompt } = extractFullPrompts(body);
  const payload: UsagePayload = {
    kilo_user_id: context?.kiloUserId ?? null,
    organization_id: context?.organizationId ?? null,
    project_id: context?.projectId ?? null,
    ip_address: fraudHeaders.http_x_forwarded_for,
    geo_city: fraudHeaders.geo_city,
    geo_country: fraudHeaders.geo_country,
    geo_latitude: fraudHeaders.geo_latitude,
    geo_longitude: fraudHeaders.geo_longitude,
    ja4_digest: fraudHeaders.ja3_hash,
    user_agent: fraudHeaders.http_user_agent,
    provider: context?.provider ?? null,
    requested_model: body.model?.toLowerCase() ?? null,
    user_prompt: userPrompt,
    system_prompt: systemPrompt,
    max_tokens: body.max_tokens ?? null,
    has_middle_out_transform: body.transforms?.includes('middle-out') ?? false,
    has_tools: (body.tools?.length ?? 0) > 0,
    streamed: body.stream === true,
    is_user_byok: context?.isByok ?? null,
    editor_name: editorName,
  };
  return classifyRequest(serviceUrl, secrets, payload);
}

type CostUpdatePayload = {
  kilo_user_id?: string | null;
  ip_address?: string | null;
  ja4_digest?: string | null;
  user_agent?: string | null;
  request_id: number;
  message_id: string;
  cost: number;
  requested_model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_write_tokens?: number | null;
  cache_hit_tokens?: number | null;
};

export async function reportCost(
  serviceUrl: string,
  secrets: AbuseServiceSecrets | undefined,
  payload: CostUpdatePayload
): Promise<CostUpdateResponse | null> {
  if (!serviceUrl) return null;
  try {
    const response = await fetch(`${serviceUrl}/api/usage/cost`, {
      method: 'POST',
      headers: buildAccessHeaders(secrets),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error(`[Abuse] Cost update failed (${response.status}): ${await response.text()}`);
      return null;
    }
    return (await response.json()) as CostUpdateResponse;
  } catch (err) {
    console.error('[Abuse] Failed to report cost:', err);
    return null;
  }
}

export async function reportAbuseCost(
  serviceUrl: string,
  secrets: AbuseServiceSecrets | undefined,
  usageContext: {
    kiloUserId: string;
    fraudHeaders: FraudDetectionHeaders;
    requested_model: string;
    abuse_request_id?: number;
  },
  usageStats: {
    messageId: string | null;
    cost_mUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheHitTokens: number;
  }
): Promise<CostUpdateResponse | null> {
  if (!usageContext.abuse_request_id || !usageStats.messageId) return null;
  return reportCost(serviceUrl, secrets, {
    kilo_user_id: usageContext.kiloUserId,
    ip_address: usageContext.fraudHeaders.http_x_forwarded_for,
    ja4_digest: usageContext.fraudHeaders.ja3_hash,
    user_agent: usageContext.fraudHeaders.http_user_agent,
    request_id: usageContext.abuse_request_id,
    message_id: usageStats.messageId,
    cost: usageStats.cost_mUsd,
    requested_model: usageContext.requested_model,
    input_tokens: usageStats.inputTokens,
    output_tokens: usageStats.outputTokens,
    cache_write_tokens: usageStats.cacheWriteTokens,
    cache_hit_tokens: usageStats.cacheHitTokens,
  });
}
