import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/providers/anthropic';
import { minimax_m25_free_model } from '@/lib/providers/minimax';
import type { OpenRouterReasoningConfig } from '@/lib/providers/openrouter/types';
import type { ModelSettings, OpenCodeSettings, Verbosity } from '@kilocode/db/schema-types';

type AutoModel = {
  id: string;
  name: string;
  description: string;
  context_length: number;
  max_completion_tokens: number;
  prompt_price: string;
  completion_price: string;
  supports_images: boolean;
  roocode_settings: ModelSettings | undefined;
  opencode_settings: OpenCodeSettings | undefined;
};

export const KILO_AUTO_FRONTIER_MODEL: AutoModel = {
  id: 'kilo-auto/frontier',
  name: 'Kilo Auto Frontier',
  description: 'Automatically routes your request to the best model for the task.',
  context_length: 1_000_000,
  max_completion_tokens: 128_000,
  prompt_price: '0.000005',
  completion_price: '0.000025',
  supports_images: true,
  roocode_settings: undefined,
  opencode_settings: {
    family: 'claude',
    prompt: 'anthropic',
  },
};

export const KILO_AUTO_FREE_MODEL: AutoModel = {
  id: 'kilo-auto/free',
  name: 'Kilo Auto Free',
  description: 'Automatically routes your request to a free model.',
  context_length: minimax_m25_free_model.context_length,
  max_completion_tokens: minimax_m25_free_model.max_completion_tokens,
  prompt_price: '0',
  completion_price: '0',
  supports_images: false,
  roocode_settings: {
    included_tools: ['search_and_replace'],
    excluded_tools: ['apply_diff', 'edit_file'],
  },
  opencode_settings: undefined,
};

export const KILO_AUTO_SMALL_MODEL: AutoModel = {
  id: 'kilo-auto/small',
  name: 'Kilo Auto Small',
  description: 'Automatically routes your request to a small model.',
  context_length: 400_000,
  max_completion_tokens: 128_000,
  prompt_price: '0.00000005',
  completion_price: '0.0000004',
  supports_images: true,
  roocode_settings: undefined,
  opencode_settings: {
    family: 'gpt',
    prompt: 'codex',
  },
};

export const AUTO_MODELS = [KILO_AUTO_FRONTIER_MODEL, KILO_AUTO_FREE_MODEL, KILO_AUTO_SMALL_MODEL];

export function isKiloAutoModel(model: string) {
  return AUTO_MODELS.some(m => m.id === model) || legacyMapping[model] !== undefined;
}

type ResolvedAutoModel = {
  model: string;
  reasoning?: OpenRouterReasoningConfig;
  verbosity?: Verbosity;
};

const CODE_MODEL: ResolvedAutoModel = {
  model: CLAUDE_SONNET_CURRENT_MODEL_ID,
  reasoning: { enabled: true },
  verbosity: 'low',
};

// Mode → model mappings for kilo-auto/frontier routing.
// Add/remove/modify entries here to change routing behavior.
const MODE_TO_MODEL = new Map<string, ResolvedAutoModel>([
  // Opus modes (planning, reasoning, orchestration, debugging)
  [
    'plan',
    { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' },
  ],
  [
    'general',
    { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'medium' },
  ],
  [
    'architect',
    { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' },
  ],
  [
    'orchestrator',
    { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' },
  ],
  ['ask', { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' }],
  [
    'debug',
    { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' },
  ],
  // Sonnet modes (implementation, exploration)
  [
    'build',
    { model: CLAUDE_SONNET_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'medium' },
  ],
  [
    'explore',
    { model: CLAUDE_SONNET_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'medium' },
  ],
  ['code', CODE_MODEL],
]);

const legacyMapping: Record<string, string | undefined> = {
  'kilo/auto': KILO_AUTO_FRONTIER_MODEL.id,
  'kilo/auto-free': KILO_AUTO_FREE_MODEL.id,
  'kilo/auto-small': KILO_AUTO_SMALL_MODEL.id,
};

export function deprecatedAutoModelsToPreventNewExtensionModelPickerFromGettingStuck() {
  const mapping = Object.fromEntries(Object.entries(legacyMapping).map(([a, b]) => [b, a]));
  return AUTO_MODELS.map(m => ({
    ...m,
    id: mapping[m.id],
    name: 'Deprecated: ' + m.name,
    description: `${mapping[m.id]} is deprecated, use ${m.id} instead`,
  }));
}

export function resolveAutoModel(model: string, modeHeader: string | null): ResolvedAutoModel {
  const mappedModel = legacyMapping[model] ?? model;
  if (mappedModel === KILO_AUTO_FREE_MODEL.id) {
    return { model: minimax_m25_free_model.public_id };
  }
  if (mappedModel === KILO_AUTO_SMALL_MODEL.id) {
    return { model: 'openai/gpt-5-nano' };
  }
  const mode = modeHeader?.trim().toLowerCase() ?? '';
  return MODE_TO_MODEL.get(mode) ?? CODE_MODEL;
}
