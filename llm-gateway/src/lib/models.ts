// Model classification helpers.
// Direct port of src/lib/models.ts — pure functions, no side effects.

type KiloFreeModel = {
  public_id: string;
  context_length: number;
  is_enabled: boolean;
  inference_providers: string[];
};

// Keep in sync with src/lib/providers/*.ts
const kiloFreeModels: KiloFreeModel[] = [
  {
    public_id: 'corethink:free',
    context_length: 78_000,
    is_enabled: true,
    inference_providers: ['corethink'],
  },
  {
    public_id: 'giga-potato',
    context_length: 256_000,
    is_enabled: true,
    inference_providers: ['stealth'],
  },
  {
    public_id: 'giga-potato-thinking',
    context_length: 256_000,
    is_enabled: true,
    inference_providers: ['stealth'],
  },
  {
    public_id: 'moonshotai/kimi-k2.5:free',
    context_length: 262_144,
    is_enabled: true,
    inference_providers: [],
  },
  {
    public_id: 'minimax/minimax-m2.5:free',
    context_length: 204_800,
    is_enabled: true,
    inference_providers: [],
  },
  {
    public_id: 'x-ai/grok-code-fast-1:optimized:free',
    context_length: 256_000,
    is_enabled: false,
    inference_providers: ['stealth'],
  },
  {
    public_id: 'z-ai/glm-5:free',
    context_length: 202_800,
    is_enabled: false,
    inference_providers: [],
  },
];

// Models tested and recommended for Vercel AI Gateway routing.
// Keep in sync with src/lib/models.ts preferredModels.
export const preferredModels: string[] = [
  'kilo/auto',
  'kilo/auto-free',
  'minimax/minimax-m2.5:free',
  'moonshotai/kimi-k2.5:free',
  'giga-potato-thinking',
  'arcee-ai/trinity-large-preview:free',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.2',
  'openai/gpt-5.3-codex',
  'google/gemini-3.1-pro-preview',
  'z-ai/glm-5',
  'x-ai/grok-code-fast-1',
];

// A model is "free" if it's a Kilo-hosted free model, ends in ':free', is the
// OpenRouter free catch-all, or is an OpenRouter stealth (alpha/beta) model.
export function isFreeModel(model: string): boolean {
  return (
    kiloFreeModels.some(m => m.public_id === model && m.is_enabled) ||
    model.endsWith(':free') ||
    model === 'openrouter/free' ||
    isOpenRouterStealthModel(model)
  );
}

// Kilo-hosted free models only (not generic :free OpenRouter models).
export function isKiloFreeModel(model: string): boolean {
  return kiloFreeModels.some(m => m.public_id === model && m.is_enabled);
}

// A dead free model has been disabled — return a clear error instead of proxying.
export function isDeadFreeModel(model: string): boolean {
  return kiloFreeModels.some(m => m.public_id === model && !m.is_enabled);
}

// Models that are so rate-limited upstream that they're effectively unusable.
const rateLimitedToDeathModelIds: ReadonlySet<string> = new Set([
  'arcee-ai/trinity-mini:free',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
  'deepseek/deepseek-r1-0528:free',
  'google/gemma-3-12b-it:free',
  'google/gemma-3-27b-it:free',
  'google/gemma-3-4b-it:free',
  'google/gemma-3n-e2b-it:free',
  'google/gemma-3n-e4b-it:free',
  'liquid/lfm-2.5-1.2b-instruct:free',
  'liquid/lfm-2.5-1.2b-thinking:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free',
  'qwen/qwen3-4b:free',
  'qwen/qwen3-coder:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'upstage/solar-pro-3:free',
  'z-ai/glm-4.5-air:free',
]);

export function isRateLimitedToDeath(modelId: string): boolean {
  return rateLimitedToDeathModelIds.has(modelId);
}

function isOpenRouterStealthModel(model: string): boolean {
  return model.startsWith('openrouter/') && (model.endsWith('-alpha') || model.endsWith('-beta'));
}

// Data collection is required for Kilo-hosted free models when prompt training
// is not explicitly allowed by the provider config.
export function isDataCollectionRequiredOnKiloCodeOnly(model: string): boolean {
  return kiloFreeModels.some(m => m.public_id === model && m.is_enabled);
}

// Returns context_length for a Kilo free model, or undefined for other models.
export function getKiloFreeModelContextLength(model: string): number | undefined {
  return kiloFreeModels.find(m => m.public_id === model)?.context_length;
}

// A Kilo free model routed through a stealth inference provider.
export function isKiloStealthModel(model: string): boolean {
  return kiloFreeModels.some(
    m => m.public_id === model && m.inference_providers.includes('stealth')
  );
}
