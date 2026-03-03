// Response helpers — port of src/lib/llm-proxy-helpers.ts (response-side utilities).
// All functions use plain Fetch API constructs (no Next.js dependencies).

import type { OpenRouterChatCompletionRequest } from '../types/request';
import { getKiloFreeModelContextLength, isKiloStealthModel } from './models';

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
  requestedModel,
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

  // Sometimes upstream returns generic or nonsensical errors when the context length
  // is exceeded. If we can detect that the request likely exceeds the model's context
  // window, return a clear message instead.
  const contextLength = getKiloFreeModelContextLength(requestedModel);
  if (contextLength) {
    const estimatedTokenCount = estimateTokenCount(request);
    if (estimatedTokenCount >= contextLength) {
      const error = `The maximum context length is ${contextLength} tokens. However, about ${estimatedTokenCount} tokens were requested.`;
      console.warn(`Responding with ${response.status} ${error}`);
      return Response.json({ error, message: error }, { status: response.status });
    }
  }

  if (isKiloStealthModel(requestedModel)) {
    const error = 'Stealth model unable to process request';
    console.warn(`Responding with ${response.status} ${error}`);
    return Response.json({ error, message: error }, { status: response.status });
  }

  return undefined;
}

// Matches the reference estimateTokenCount in llm-proxy-helpers.ts:
// rough char/4 approximation + max output tokens.
function estimateTokenCount(request: OpenRouterChatCompletionRequest): number {
  const maxOutputTokens = Number(request.max_completion_tokens ?? request.max_tokens ?? 0);
  return Math.round(JSON.stringify(request).length / 4 + maxOutputTokens);
}
