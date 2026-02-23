import { describe, expect, test } from '@jest/globals';
import {
  createProvidersAndModelsAllowListsInitialState,
  providersAndModelsAllowListsReducer,
  type ProvidersAndModelsAllowListsState,
} from '@/components/organizations/providers-and-models/useProvidersAndModelsAllowListsState';

describe('providersAndModelsAllowListsReducer', () => {
  test('init -> toggle -> reset returns to initial', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelAllowList: ['openai/gpt-4.1'],
      providerAllowList: [],
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    state = providersAndModelsAllowListsReducer(state, {
      type: 'TOGGLE_MODEL',
      modelId: 'openai/gpt-4.1',
      nextAllowed: false,
      allModelIds: ['openai/gpt-4.1'],
      providerSlugsForModelId: ['openai'],
    });

    state = providersAndModelsAllowListsReducer(state, { type: 'RESET_TO_INITIAL' });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.draftModelAllowList).toEqual(state.initialModelAllowList);
    expect(state.draftProviderAllowList).toEqual(state.initialProviderAllowList);
    expect(state.modelNoneAllowed).toEqual(state.initialModelNoneAllowed);
  });

  test('init -> toggle -> mark saved marks clean (draft becomes initial)', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelAllowList: [],
      providerAllowList: [],
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    state = providersAndModelsAllowListsReducer(state, {
      type: 'TOGGLE_PROVIDER',
      providerSlug: 'openai',
      nextEnabled: false,
      allProviderSlugsWithEndpoints: ['openai', 'anthropic'],
    });

    state = providersAndModelsAllowListsReducer(state, { type: 'MARK_SAVED' });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.initialProviderAllowList).toEqual(state.draftProviderAllowList);
    expect(state.initialModelAllowList).toEqual(state.draftModelAllowList);
    expect(state.initialModelNoneAllowed).toEqual(state.modelNoneAllowed);
  });

  test('SET_ALL_MODELS_ALLOWED(true) selects all models', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelAllowList: ['openai/gpt-4.1'],
      providerAllowList: [],
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    state = providersAndModelsAllowListsReducer(state, {
      type: 'SET_ALL_MODELS_ALLOWED',
      targetModelIds: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1'],
      nextAllowed: true,
      allModelIds: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1'],
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.draftModelAllowList).toEqual(['anthropic/claude-3.5-sonnet', 'openai/gpt-4.1']);
    expect(state.modelNoneAllowed).toBe(false);
  });

  test('SET_ALL_MODELS_ALLOWED(false) deselects all models', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelAllowList: [],
      providerAllowList: [],
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    state = providersAndModelsAllowListsReducer(state, {
      type: 'SET_ALL_MODELS_ALLOWED',
      targetModelIds: ['openai/gpt-4.1'],
      nextAllowed: false,
      allModelIds: ['openai/gpt-4.1'],
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.draftModelAllowList).toEqual([]);
    expect(state.modelNoneAllowed).toBe(true);
  });
});
