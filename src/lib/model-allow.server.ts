import 'server-only';

export type ProviderAwareAllowPredicate = (modelId: string) => Promise<boolean>;

export function createAllowPredicateFromDenyList(
  denyList: string[] | undefined
): ProviderAwareAllowPredicate {
  const denyListSet = new Set(denyList);
  return (modelId: string): Promise<boolean> => {
    return Promise.resolve(!denyListSet.has(modelId));
  };
}
