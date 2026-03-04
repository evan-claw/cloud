import 'server-only';

import { normalizeModelId } from '@/lib/model-utils';

export type ProviderAwareAllowPredicate = (modelId: string) => Promise<boolean>;

export function createAllowPredicateFromDenyList(
  denyList: string[] | undefined
): ProviderAwareAllowPredicate {
  const denyListSet = new Set(denyList);
  return (modelId: string): Promise<boolean> => {
    const normalizedModelId = normalizeModelId(modelId);
    return Promise.resolve(!denyListSet.has(normalizedModelId));
  };
}
