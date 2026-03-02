import { describe, it, expect } from 'vitest';
import { checkOrganizationModelRestrictions } from '../../src/lib/org-restrictions';

describe('checkOrganizationModelRestrictions', () => {
  it('allows everything when no settings', () => {
    const result = checkOrganizationModelRestrictions({ modelId: 'anthropic/claude-3-opus' });
    expect(result.error).toBeNull();
    expect(result.providerConfig).toBeUndefined();
  });

  it('allows everything when settings is empty', () => {
    const result = checkOrganizationModelRestrictions({
      modelId: 'anthropic/claude-3-opus',
      settings: {},
      organizationPlan: 'teams',
    });
    expect(result.error).toBeNull();
  });

  it('skips model allow list for teams plan', () => {
    const result = checkOrganizationModelRestrictions({
      modelId: 'anthropic/claude-3-opus',
      settings: { model_allow_list: ['openai/gpt-4'] },
      organizationPlan: 'teams',
    });
    expect(result.error).toBeNull();
  });

  it('blocks model not in allow list for enterprise plan', () => {
    const result = checkOrganizationModelRestrictions({
      modelId: 'anthropic/claude-3-opus',
      settings: { model_allow_list: ['openai/gpt-4'] },
      organizationPlan: 'enterprise',
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.status).toBe(404);
  });

  it('allows model in allow list for enterprise plan (exact match)', () => {
    const result = checkOrganizationModelRestrictions({
      modelId: 'anthropic/claude-3-opus',
      settings: { model_allow_list: ['anthropic/claude-3-opus'] },
      organizationPlan: 'enterprise',
    });
    expect(result.error).toBeNull();
  });

  it('allows model via wildcard in allow list for enterprise plan', () => {
    const result = checkOrganizationModelRestrictions({
      modelId: 'anthropic/claude-3-opus',
      settings: { model_allow_list: ['anthropic/*'] },
      organizationPlan: 'enterprise',
    });
    expect(result.error).toBeNull();
  });

  it('strips :free suffix before matching', () => {
    const result = checkOrganizationModelRestrictions({
      modelId: 'anthropic/claude-3-haiku:free',
      settings: { model_allow_list: ['anthropic/*'] },
      organizationPlan: 'enterprise',
    });
    expect(result.error).toBeNull();
  });

  it('sets provider config only when from enterprise plan', () => {
    const result = checkOrganizationModelRestrictions({
      modelId: 'anthropic/claude-3-opus',
      settings: { provider_allow_list: ['anthropic', 'openai'] },
      organizationPlan: 'enterprise',
    });
    expect(result.error).toBeNull();
    expect(result.providerConfig?.only).toEqual(['anthropic', 'openai']);
  });

  it('does not set provider allow list for teams plan', () => {
    const result = checkOrganizationModelRestrictions({
      modelId: 'anthropic/claude-3-opus',
      settings: { provider_allow_list: ['anthropic'] },
      organizationPlan: 'teams',
    });
    expect(result.error).toBeNull();
    expect(result.providerConfig?.only).toBeUndefined();
  });

  it('sets data_collection from settings regardless of plan', () => {
    const result = checkOrganizationModelRestrictions({
      modelId: 'anthropic/claude-3-opus',
      settings: { data_collection: 'deny' },
      organizationPlan: 'teams',
    });
    expect(result.error).toBeNull();
    expect(result.providerConfig?.data_collection).toBe('deny');
  });

  it('blocks kilo free model when its required provider is not in allow list', () => {
    const result = checkOrganizationModelRestrictions({
      modelId: 'giga-potato',
      settings: { provider_allow_list: ['anthropic'] },
      organizationPlan: 'enterprise',
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.status).toBe(404);
  });
});
