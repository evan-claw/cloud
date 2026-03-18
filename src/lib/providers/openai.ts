import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';

export const gpt_oss_20b_free_model: KiloFreeModel = {
  public_id: 'openai/gpt-oss-20b:free',
  display_name: 'OpenAI: GPT-OSS 20B (free)',
  description:
    'GPT-OSS 20B is a small open-weights model from OpenAI, offering efficient performance for coding and general tasks.',
  context_length: 131072,
  max_completion_tokens: 16384,
  status: 'hidden',
  flags: [],
  gateway: 'openrouter',
  internal_id: 'openai/gpt-oss-20b',
  inference_provider: null,
};

export function isOpenAiModel(requestedModel: string) {
  return requestedModel.startsWith('openai/') && !requestedModel.startsWith('openai/gpt-oss');
}

export function isOpenAiOssModel(requestedModel: string) {
  return requestedModel.startsWith('openai/gpt-oss');
}
