// Direct port of src/lib/kilo-auto-model.ts.
// "kilo/auto" is a quasi-model id that resolves to a real model based on the
// x-kilocode-mode header. The rest of the proxy flow then behaves as if the
// client had requested the resolved model directly.

const CLAUDE_SONNET = 'anthropic/claude-sonnet-4-20250514';
const CLAUDE_OPUS = 'anthropic/claude-opus-4-20250514';
const MINIMAX_FREE = 'minimax/minimax-m2.5:free';

export type ResolvedAutoModel = {
  model: string;
  reasoning?: { effort?: string; max_tokens?: number; exclude?: boolean; enabled?: boolean };
  verbosity?: 'low' | 'medium' | 'high';
};

const AUTO_MODEL_IDS = ['kilo/auto', 'kilo/auto-free', 'kilo/auto-small'] as const;

export function isKiloAutoModel(model: string): boolean {
  return (AUTO_MODEL_IDS as readonly string[]).includes(model);
}

const CODE_MODEL: ResolvedAutoModel = {
  model: CLAUDE_SONNET,
  reasoning: { enabled: true },
  verbosity: 'low',
};

const MODE_TO_MODEL = new Map<string, ResolvedAutoModel>([
  ['plan', { model: CLAUDE_OPUS, reasoning: { enabled: true }, verbosity: 'high' }],
  ['general', { model: CLAUDE_OPUS, reasoning: { enabled: true }, verbosity: 'medium' }],
  ['architect', { model: CLAUDE_OPUS, reasoning: { enabled: true }, verbosity: 'high' }],
  ['orchestrator', { model: CLAUDE_OPUS, reasoning: { enabled: true }, verbosity: 'high' }],
  ['ask', { model: CLAUDE_OPUS, reasoning: { enabled: true }, verbosity: 'high' }],
  ['debug', { model: CLAUDE_OPUS, reasoning: { enabled: true }, verbosity: 'high' }],
  ['build', { model: CLAUDE_SONNET, reasoning: { enabled: true }, verbosity: 'medium' }],
  ['explore', { model: CLAUDE_SONNET, reasoning: { enabled: true }, verbosity: 'medium' }],
  ['code', CODE_MODEL],
]);

export function resolveAutoModel(model: string, modeHeader: string | null): ResolvedAutoModel {
  if (model === 'kilo/auto-free') return { model: MINIMAX_FREE };
  if (model === 'kilo/auto-small') return { model: 'openai/gpt-5-nano' };
  const mode = modeHeader?.trim().toLowerCase() ?? '';
  return MODE_TO_MODEL.get(mode) ?? CODE_MODEL;
}
