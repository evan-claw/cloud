import type { Env } from './env';
import type { AnonymousUserContext } from './lib/anonymous';
import type { FeatureValue } from './lib/feature-detection';

// Hono context type — all middleware variables live here.
export type HonoContext = {
  Bindings: Env;
  Variables: Variables;
};

// All values set via c.set() / c.get() across the middleware chain.
// Each key is populated by the middleware listed in the comment.
export type Variables = {
  // request-timing.ts
  requestStartedAt: number;

  // parse-body.ts
  requestBody: OpenRouterChatCompletionRequest;

  // extract-ip.ts
  clientIp: string;

  // resolve-auto-model.ts: original model before auto-resolution (null when not a kilo/auto model)
  autoModel: string | null;

  // auth.ts: authenticated user or anonymous context
  user: AuthenticatedUser | AnonymousUserContext;

  // auth.ts: org/bot/token context from the JWT payload
  organizationId: string | undefined;
  botId: string | undefined;
  tokenSource: string | undefined;

  // parse-body.ts: lowercased resolved model id (after auto-resolution)
  resolvedModel: string;

  // extract-ip.ts
  modeHeader: string | null;

  // parse-body.ts
  feature: FeatureValue | null;
};

// Minimal DB user shape — only the fields the gateway actually needs.
// Mirrors the kilocode_users Drizzle schema columns used across the chain.
export type AuthenticatedUser = {
  id: string;
  google_user_email: string;
  microdollars_used: number;
  is_admin: boolean;
  api_token_pepper: string | null;
};

// OpenRouter-compatible chat completion request.
// Intentionally loose — we pass through unknown fields to upstream.
export type OpenRouterChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  tools?: unknown[];
  transforms?: string[];
  provider?: {
    order?: string[];
    only?: string[];
    data_collection?: 'allow' | 'deny';
    zdr?: boolean;
  };
  reasoning?: { effort?: string; max_tokens?: number; exclude?: boolean; enabled?: boolean };
  verbosity?: string;
  prompt_cache_key?: string;
  safety_identifier?: string;
  user?: string;
  [key: string]: unknown;
};

export type ChatMessage = {
  role: string;
  content: string | unknown[];
  [key: string]: unknown;
};
