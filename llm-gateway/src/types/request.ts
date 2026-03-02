// OpenRouter-compatible chat completion request shape.
// Intentionally loose — unknown fields are passed through to upstream.

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
