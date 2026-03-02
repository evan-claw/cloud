import type { Env } from './env';

// Hono context type — all middleware variables live here.
// Keys are added incrementally as middleware runs.
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

  // resolve-auto-model.ts: original model before auto-resolution
  originalModel: string;
};

// Minimal shape of an OpenRouter-compatible chat completion request.
// Expanded in later phases with all required fields.
export type OpenRouterChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  tools?: unknown[];
  [key: string]: unknown;
};

export type ChatMessage = {
  role: string;
  content: string | unknown[];
  [key: string]: unknown;
};
