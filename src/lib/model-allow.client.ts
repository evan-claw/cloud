import 'client-only';

import { normalizeModelId } from '@/lib/model-utils';
import {
  isAllowedByExactOrNamespaceWildcard,
  isAllowedByProviderMembershipWildcard,
  prepareModelAllowList,
} from '@/lib/model-allow.shared';

export type OpenRouterProviderModelsSnapshot = Array<{
  slug: string;
  models: Array<{
    slug: string;
    endpoint?: unknown;
  }>;
}>;

type ModelProvidersIndex = Map<string, Set<string>>;

const modelProvidersIndexCache = new WeakMap<
  ReadonlyArray<{ slug: string; models: ReadonlyArray<{ slug: string }> }>,
  ModelProvidersIndex
>();

function getOrBuildModelProvidersIndex(
  openRouterProviders: OpenRouterProviderModelsSnapshot
): ModelProvidersIndex {
  const cached = modelProvidersIndexCache.get(openRouterProviders);
  if (cached) {
    return cached;
  }

  const index: ModelProvidersIndex = new Map();
  for (const provider of openRouterProviders) {
    for (const model of provider.models) {
      const normalizedModelId = normalizeModelId(model.slug);
      const providersForModel = index.get(normalizedModelId);
      if (providersForModel) {
        providersForModel.add(provider.slug);
      } else {
        index.set(normalizedModelId, new Set([provider.slug]));
      }
    }
  }

  modelProvidersIndexCache.set(openRouterProviders, index);
  return index;
}

/**
 * Client-safe allow-list evaluation that mirrors
 * [`createProviderAwareModelAllowPredicate()`](src/lib/model-allow.server.ts:12).
 * @deprecated
 */
export function isModelAllowedProviderAwareClient(
  modelId: string,
  allowList: string[],
  openRouterProviders: OpenRouterProviderModelsSnapshot
): boolean {
  if (allowList.length === 0) {
    return true;
  }

  const normalizedModelId = normalizeModelId(modelId);

  const { allowListSet, wildcardProviderSlugs } = prepareModelAllowList(allowList);

  if (isAllowedByExactOrNamespaceWildcard(normalizedModelId, allowListSet)) {
    return true;
  }

  // 3) Provider-membership wildcard match
  if (wildcardProviderSlugs.size === 0) {
    return false;
  }

  const modelProvidersIndex = getOrBuildModelProvidersIndex(openRouterProviders);
  const providersForModel = modelProvidersIndex.get(normalizedModelId);
  return isAllowedByProviderMembershipWildcard(
    providersForModel || new Set(),
    wildcardProviderSlugs
  );
}
