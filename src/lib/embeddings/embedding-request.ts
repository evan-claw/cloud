import type { ProviderId } from '@/lib/providers/provider-id';

export type EmbeddingProxyRequest = {
  model: string;
  input: unknown;
  encoding_format?: string;
  dimensions?: number;
  user?: string;
  provider?: Record<string, unknown>;
  input_type?: string;
  // Mistral-specific
  output_dtype?: string;
  output_dimension?: number;
};

/**
 * Build the upstream request body for the target provider.
 * Strips fields the target doesn't understand and translates field names where necessary.
 */
export function buildUpstreamBody(
  body: EmbeddingProxyRequest,
  providerId: ProviderId
): Record<string, unknown> {
  if (providerId === 'mistral') {
    // Mistral API: strip OpenRouter-only fields, map dimensions → output_dimension
    const mistralBody: Record<string, unknown> = {
      model: body.model,
      input: body.input,
    };
    if (body.encoding_format != null) mistralBody.encoding_format = body.encoding_format;
    if (body.output_dimension != null) {
      mistralBody.output_dimension = body.output_dimension;
    } else if (body.dimensions != null) {
      mistralBody.output_dimension = body.dimensions;
    }
    if (body.output_dtype != null) mistralBody.output_dtype = body.output_dtype;
    return mistralBody;
  }

  if (providerId === 'openai') {
    // OpenAI API: same field names as OpenRouter, strip Mistral-only and provider routing fields
    const openaiBody: Record<string, unknown> = {
      model: body.model,
      input: body.input,
    };
    if (body.encoding_format != null) openaiBody.encoding_format = body.encoding_format;
    if (body.dimensions != null) openaiBody.dimensions = body.dimensions;
    if (body.user != null) openaiBody.user = body.user;
    return openaiBody;
  }

  // OpenRouter / Vercel: forward body as-is, strip Mistral-only fields
  const { output_dtype: _, output_dimension: __, ...openRouterBody } = body;
  return openRouterBody;
}

/**
 * Strip the provider prefix from a model ID.
 * e.g. "mistralai/mistral-embed" → "mistral-embed", "openai/text-embedding-3-small" → "text-embedding-3-small"
 */
export function stripModelPrefix(model: string): string {
  const slashIndex = model.indexOf('/');
  return slashIndex >= 0 ? model.slice(slashIndex + 1) : model;
}
