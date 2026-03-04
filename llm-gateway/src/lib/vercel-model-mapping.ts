// Shared Vercel model-ID mapping — single source of truth.
// Mirrors src/lib/providers/vercel/mapModelIdToVercel.ts from the reference.
//
// Both BYOK provider lookups and Vercel routing need to translate
// OpenRouter-style model IDs into Vercel AI Gateway equivalents.

const vercelModelIdOverrides: Record<string, string | undefined> = {
  'arcee-ai/trinity-large-preview:free': 'arcee-ai/trinity-large-preview',
  'mistralai/codestral-2508': 'mistral/codestral',
  'mistralai/devstral-2512': 'mistral/devstral-2',
};

const prefixToVercelProvider: Record<string, string | undefined> = {
  anthropic: 'anthropic',
  google: 'google',
  openai: 'openai',
  minimax: 'minimax',
  mistralai: 'mistral',
  'x-ai': 'xai',
  'z-ai': 'zai',
};

/**
 * Translate an OpenRouter model ID to the Vercel AI Gateway equivalent.
 *
 * @param resolveInternalId — optional callback that resolves a public free-model
 *   ID to its internal model ID. Callers that have access to the free-model list
 *   (e.g. provider-specific.ts) pass this in; callers that don't (e.g. byok.ts)
 *   can omit it — the mapping still works for non-free models.
 */
export function mapModelIdToVercel(
  modelId: string,
  resolveInternalId?: (publicId: string) => string | undefined
): string {
  const hardcoded = vercelModelIdOverrides[modelId];
  if (hardcoded) return hardcoded;

  const baseId = resolveInternalId?.(modelId) ?? modelId;

  const slashIndex = baseId.indexOf('/');
  if (slashIndex < 0) return baseId;

  const prefix = baseId.slice(0, slashIndex);
  const isGptOss = baseId.startsWith('openai/gpt-oss');
  const vercelProvider = isGptOss ? undefined : prefixToVercelProvider[prefix];
  return vercelProvider ? vercelProvider + baseId.slice(slashIndex) : baseId;
}
