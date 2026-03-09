import { describe, it, expect } from '@jest/globals';
import { checkOrganizationModelRestrictions } from './llm-proxy-helpers';

describe('checkOrganizationModelRestrictions', () => {
  describe('enterprise plan - model deny list restrictions', () => {
    it('should allow model when it is not in the deny list on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_deny_list: ['openai/gpt-4'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
    });

    it('should block model when it is in the deny list on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_deny_list: ['anthropic/claude-3-opus'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).not.toBeNull();
      expect(result.error?.status).toBe(404);
    });

    it('should allow any model when deny list is empty on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_deny_list: [],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
    });

    it('should allow any model when deny list is undefined on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {},
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
    });

    it('should block multiple denied models on enterprise plan', () => {
      const settings = {
        model_deny_list: ['anthropic/claude-3-opus', 'openai/gpt-3.5-turbo'],
      };

      expect(
        checkOrganizationModelRestrictions({
          modelId: 'anthropic/claude-3-opus',
          settings,
          organizationPlan: 'enterprise',
        }).error
      ).not.toBeNull();

      expect(
        checkOrganizationModelRestrictions({
          modelId: 'openai/gpt-3.5-turbo',
          settings,
          organizationPlan: 'enterprise',
        }).error
      ).not.toBeNull();

      expect(
        checkOrganizationModelRestrictions({
          modelId: 'openai/gpt-4',
          settings,
          organizationPlan: 'enterprise',
        }).error
      ).toBeNull();
    });
  });

  describe('teams plan - model deny list should NOT apply', () => {
    it('should allow any model on teams plan even with model_deny_list set', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_deny_list: ['anthropic/claude-3-opus'],
        },
        organizationPlan: 'teams',
      });

      expect(result.error).toBeNull();
    });
  });

  describe('no organization plan (individual users)', () => {
    it('should allow any model when no organization plan is set', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_deny_list: ['anthropic/claude-3-opus'],
        },
        // No organizationPlan - individual user
      });

      expect(result.error).toBeNull();
    });
  });

  describe('provider deny list - applies to enterprise plans', () => {
    it('should return provider config with ignored providers for enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_deny_list: ['openai'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ ignore: ['openai'] });
    });

    it('should not return providerConfig for teams plan with provider_deny_list', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_deny_list: ['openai'],
        },
        organizationPlan: 'teams',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toBeUndefined();
    });

    it('should not return providerConfig when provider_deny_list is empty', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_deny_list: [],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toBeUndefined();
    });
  });

  describe('data collection - applies to all plans', () => {
    it('should return data_collection in provider config when set to allow', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          data_collection: 'allow',
        },
        organizationPlan: 'teams',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ data_collection: 'allow' });
    });

    it('should return data_collection in provider config when set to deny', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          data_collection: 'deny',
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ data_collection: 'deny' });
    });

    it('should combine provider_deny_list and data_collection in provider config', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_deny_list: ['openai'],
          data_collection: 'deny',
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ ignore: ['openai'], data_collection: 'deny' });
    });
  });

  describe('no settings', () => {
    it('should return no error and no provider config when settings is undefined', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: undefined,
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toBeUndefined();
    });
  });
});
