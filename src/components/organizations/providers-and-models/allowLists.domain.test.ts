import { describe, expect, test } from '@jest/globals';
import {
  buildModelProvidersIndex,
  canonicalizeModelAllowList,
  computeAllowedModelIds,
  computeEnabledProviderSlugs,
  setAllModelsAllowed,
  toggleAllowFutureModelsForProvider,
  toggleModelAllowed,
  toggleProviderEnabled,
} from '@/components/organizations/providers-and-models/allowLists.domain';

describe('allowLists.domain', () => {
  test('`[]` provider_allow_list means all providers enabled', () => {
    const enabled = computeEnabledProviderSlugs([], ['a', 'b']);
    expect([...enabled].sort()).toEqual(['a', 'b']);
  });

  test('`[]` model_allow_list means all models allowed (normalized)', () => {
    const openRouterModels = [{ slug: 'openai/gpt-4.1:free' }, { slug: 'openai/gpt-4.1' }];
    const openRouterProviders = [
      {
        slug: 'openai',
        models: [{ slug: 'openai/gpt-4.1', endpoint: {} }],
      },
    ];

    const allowed = computeAllowedModelIds([], false, openRouterModels, openRouterProviders);
    expect([...allowed].sort()).toEqual(['openai/gpt-4.1']);
  });

  test('canonicalizeModelAllowList normalizes :free and dedupes', () => {
    expect(canonicalizeModelAllowList(['openai/gpt-4.1:free', 'openai/gpt-4.1'])).toEqual([
      'openai/gpt-4.1',
    ]);
  });

  test('toggleProviderEnabled(disable) removes provider wildcard from model allow list', () => {
    const { nextModelAllowList, nextProviderAllowList } = toggleProviderEnabled({
      providerSlug: 'cerebras',
      nextEnabled: false,
      draftProviderAllowList: [],
      draftModelAllowList: ['cerebras/*', 'openai/gpt-4.1'],
      allProviderSlugsWithEndpoints: ['cerebras', 'openai'],
      hadAllProvidersInitially: true,
    });

    expect(nextModelAllowList).toEqual(['openai/gpt-4.1']);
    expect(nextProviderAllowList.sort()).toEqual(['openai']);
  });

  test('toggleAllowFutureModelsForProvider enables provider and adds provider wildcard', () => {
    const { nextModelAllowList, nextProviderAllowList } = toggleAllowFutureModelsForProvider({
      providerSlug: 'cerebras',
      nextAllowed: true,
      draftModelAllowList: ['openai/gpt-4.1'],
      draftProviderAllowList: ['openai'],
      allProviderSlugsWithEndpoints: ['cerebras', 'openai'],
      hadAllProvidersInitially: false,
    });

    expect(nextModelAllowList.sort()).toEqual(['cerebras/*', 'openai/gpt-4.1']);
    expect(nextProviderAllowList.sort()).toEqual(['cerebras', 'openai']);
  });

  test('toggleModelAllowed(disable) removes provider wildcards for providers offering the model', () => {
    const providerIndex = buildModelProvidersIndex([
      {
        slug: 'cerebras',
        models: [{ slug: 'z-ai/glm4.6', endpoint: {} }],
      },
    ]);

    const { nextModelAllowList, nextModelNoneAllowed } = toggleModelAllowed({
      modelId: 'z-ai/glm4.6',
      nextAllowed: false,
      draftModelAllowList: ['cerebras/*', 'z-ai/glm4.6'],
      modelNoneAllowed: false,
      allModelIds: ['z-ai/glm4.6'],
      providerSlugsForModelId: [...(providerIndex.get('z-ai/glm4.6') ?? [])],
      hadAllModelsInitially: false,
    });

    expect(nextModelAllowList).toEqual([]);
    expect(nextModelNoneAllowed).toBe(false);
  });

  test('toggleModelAllowed(true) from none-allowed state enables just that model', () => {
    const { nextModelAllowList, nextModelNoneAllowed } = toggleModelAllowed({
      modelId: 'openai/gpt-4.1',
      nextAllowed: true,
      draftModelAllowList: [],
      modelNoneAllowed: true,
      allModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet'],
      providerSlugsForModelId: ['openai'],
      hadAllModelsInitially: true,
    });
    expect(nextModelAllowList).toEqual(['openai/gpt-4.1']);
    expect(nextModelNoneAllowed).toBe(false);
  });

  test('toggleModelAllowed(false) deselecting last model sets modelNoneAllowed', () => {
    const { nextModelAllowList, nextModelNoneAllowed } = toggleModelAllowed({
      modelId: 'openai/gpt-4.1',
      nextAllowed: false,
      draftModelAllowList: ['openai/gpt-4.1'],
      modelNoneAllowed: false,
      allModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet'],
      providerSlugsForModelId: ['openai'],
      hadAllModelsInitially: false,
    });
    expect(nextModelAllowList).toEqual([]);
    expect(nextModelNoneAllowed).toBe(true);
  });

  test('toggleModelAllowed(false) from none-allowed state is a no-op', () => {
    const { nextModelAllowList, nextModelNoneAllowed } = toggleModelAllowed({
      modelId: 'openai/gpt-4.1',
      nextAllowed: false,
      draftModelAllowList: [],
      modelNoneAllowed: true,
      allModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet'],
      providerSlugsForModelId: ['openai'],
      hadAllModelsInitially: true,
    });
    expect(nextModelAllowList).toEqual([]);
    expect(nextModelNoneAllowed).toBe(true);
  });

  test('setAllModelsAllowed(true) returns [] when hadAllModelsInitially and targeting all', () => {
    const { nextModelAllowList, nextModelNoneAllowed } = setAllModelsAllowed({
      nextAllowed: true,
      targetModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet'],
      draftModelAllowList: ['openai/gpt-4.1'],
      modelNoneAllowed: false,
      allModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet'],
      hadAllModelsInitially: true,
    });
    expect(nextModelAllowList).toEqual([]);
    expect(nextModelNoneAllowed).toBe(false);
  });

  test('setAllModelsAllowed(true) returns all model IDs when not hadAllModelsInitially', () => {
    const { nextModelAllowList, nextModelNoneAllowed } = setAllModelsAllowed({
      nextAllowed: true,
      targetModelIds: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1'],
      draftModelAllowList: ['openai/gpt-4.1'],
      modelNoneAllowed: false,
      allModelIds: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1'],
      hadAllModelsInitially: false,
    });
    expect(nextModelAllowList).toEqual(['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1']);
    expect(nextModelNoneAllowed).toBe(false);
  });

  test('setAllModelsAllowed(true) preserves wildcards when not hadAllModelsInitially', () => {
    const { nextModelAllowList, nextModelNoneAllowed } = setAllModelsAllowed({
      nextAllowed: true,
      targetModelIds: ['openai/gpt-4.1'],
      draftModelAllowList: ['cerebras/*', 'openai/gpt-4.1'],
      modelNoneAllowed: false,
      allModelIds: ['openai/gpt-4.1'],
      hadAllModelsInitially: false,
    });
    expect(nextModelAllowList).toEqual(['cerebras/*', 'openai/gpt-4.1']);
    expect(nextModelNoneAllowed).toBe(false);
  });

  test('setAllModelsAllowed(false) sets modelNoneAllowed when deselecting all models', () => {
    const { nextModelAllowList, nextModelNoneAllowed } = setAllModelsAllowed({
      nextAllowed: false,
      targetModelIds: ['openai/gpt-4.1'],
      draftModelAllowList: [],
      modelNoneAllowed: false,
      allModelIds: ['openai/gpt-4.1'],
      hadAllModelsInitially: true,
    });
    expect(nextModelAllowList).toEqual([]);
    expect(nextModelNoneAllowed).toBe(true);
  });

  test('setAllModelsAllowed(true) on filtered subset merges into existing allow list', () => {
    const { nextModelAllowList, nextModelNoneAllowed } = setAllModelsAllowed({
      nextAllowed: true,
      targetModelIds: ['anthropic/claude-3.5-sonnet'],
      draftModelAllowList: ['openai/gpt-4.1'],
      modelNoneAllowed: false,
      allModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet', 'meta/llama-3'],
      hadAllModelsInitially: false,
    });
    expect(nextModelAllowList).toEqual(['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1']);
    expect(nextModelNoneAllowed).toBe(false);
  });

  test('setAllModelsAllowed(false) on filtered subset removes only targets', () => {
    const { nextModelAllowList, nextModelNoneAllowed } = setAllModelsAllowed({
      nextAllowed: false,
      targetModelIds: ['openai/gpt-4.1'],
      draftModelAllowList: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1'],
      modelNoneAllowed: false,
      allModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet'],
      hadAllModelsInitially: false,
    });
    expect(nextModelAllowList).toEqual(['anthropic/claude-3.5-sonnet']);
    expect(nextModelNoneAllowed).toBe(false);
  });

  test('setAllModelsAllowed(false) from empty list (all allowed) keeps non-targets', () => {
    const { nextModelAllowList, nextModelNoneAllowed } = setAllModelsAllowed({
      nextAllowed: false,
      targetModelIds: ['openai/gpt-4.1'],
      draftModelAllowList: [],
      modelNoneAllowed: false,
      allModelIds: ['openai/gpt-4.1', 'anthropic/claude-3.5-sonnet'],
      hadAllModelsInitially: true,
    });
    expect(nextModelAllowList).toEqual(['anthropic/claude-3.5-sonnet']);
    expect(nextModelNoneAllowed).toBe(false);
  });

  test('computeAllowedModelIds returns empty set when modelNoneAllowed is true', () => {
    const openRouterModels = [{ slug: 'openai/gpt-4.1' }, { slug: 'anthropic/claude-3.5-sonnet' }];
    const openRouterProviders = [
      { slug: 'openai', models: [{ slug: 'openai/gpt-4.1', endpoint: {} }] },
      { slug: 'anthropic', models: [{ slug: 'anthropic/claude-3.5-sonnet', endpoint: {} }] },
    ];

    const allowed = computeAllowedModelIds([], true, openRouterModels, openRouterProviders);
    expect(allowed.size).toBe(0);
  });
});
