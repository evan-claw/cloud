import { PRIMARY_DEFAULT_MODEL, preferredModels } from '@/lib/models';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { createAllowPredicateFromDenyList } from '@/lib/model-allow.server';

/**
 * Get a default model that is allowed for an organization.
 * Priority: org default model > global default > preferred models > global default fallback.
 */
export async function getDefaultAllowedModel(
  organizationId: string,
  globalDefault = PRIMARY_DEFAULT_MODEL
): Promise<string> {
  const organization = await getOrganizationById(organizationId);
  if (!organization) {
    return globalDefault;
  }

  const modelDenyList = organization.settings?.model_deny_list || [];

  // If no restrictions, use global default
  if (modelDenyList.length === 0) {
    return globalDefault;
  }

  const isAllowed = createAllowPredicateFromDenyList(modelDenyList);

  // Check if the organization's default model is allowed
  const orgDefaultModel = organization.settings?.default_model;
  if (orgDefaultModel && (await isAllowed(orgDefaultModel))) {
    return orgDefaultModel;
  }

  if (globalDefault && (await isAllowed(globalDefault))) {
    return globalDefault;
  }

  // Try each preferred/recommended model in order
  for (const model of preferredModels) {
    if (await isAllowed(model)) {
      return model;
    }
  }

  // All models were blocked; fall back to global default
  console.warn(
    '[SlackBot] No allowed model found; deny list blocks all preferred models:',
    modelDenyList
  );
  return globalDefault;
}
