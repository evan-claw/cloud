import 'server-only';
import { normalizeModelId } from '@/lib/model-utils';

export type ProviderAwareAllowPredicate = (modelId: string) => Promise<boolean>;

export function createAllowPredicateFromDenyList(
  denyList: string[] | undefined
): ProviderAwareAllowPredicate {
  const denyListSet = new Set(denyList?.map(normalizeModelId));
  return (modelId: string): Promise<boolean> => {
    return Promise.resolve(!denyListSet.has(normalizeModelId(modelId)));
  };
}
