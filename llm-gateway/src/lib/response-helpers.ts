// Response helpers — port of src/lib/llm-proxy-helpers.ts (response-side utilities).
// All functions use plain Fetch API constructs (no Next.js dependencies).

import type { OpenRouterChatCompletionRequest } from '../types/request';

// Whitelist upstream headers, add Content-Encoding: identity.
// Content-Encoding: identity ensures no intermediary re-compresses the stream.
export function getOutputHeaders(response: Response): Headers {
  const out = new Headers();
  for (const key of ['date', 'content-type', 'request-id']) {
    const val = response.headers.get(key);
    if (val) out.set(key, val);
  }
  out.set('Content-Encoding', 'identity');
  return out;
}

// Wrap an upstream response for delivery to the client, stripping and
// normalising headers.
export function wrapResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: getOutputHeaders(response),
  });
}

// ─── BYOK error messages ────────────────────────────────────────────────────

const byokErrorMessages: Partial<Record<number, string>> = {
  401: '[BYOK] Your API key is invalid or has been revoked. Please check your API key configuration.',
  402: '[BYOK] Your API account has insufficient funds. Please check your billing details with your API provider.',
  403: '[BYOK] Your API key does not have permission to access this resource. Please check your API key permissions.',
  429: '[BYOK] Your API key has hit its rate limit. Please try again later or check your rate limit settings with your API provider.',
};

// Returns an alternative Response when there is a meaningful error message to
// show the client, or undefined if the original response should be forwarded.
export async function makeErrorReadable({
  request,
  response,
  isUserByok,
}: {
  requestedModel: string;
  request: OpenRouterChatCompletionRequest;
  response: Response;
  isUserByok: boolean;
}): Promise<Response | undefined> {
  if (response.status < 400) return undefined;

  if (isUserByok) {
    const msg = byokErrorMessages[response.status];
    if (msg) {
      console.warn(`Responding with ${response.status} ${msg}`);
      return Response.json({ error: msg, message: msg }, { status: response.status });
    }
  }

  // Suppress unused-variable warning: `request` reserved for context-length checks (Phase 6+)
  void request;

  return undefined;
}
