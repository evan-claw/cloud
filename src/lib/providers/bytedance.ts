import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { GatewayRequest } from '@/lib/providers/openrouter/types';

export function isByteDanceSeedModel(model: string) {
  return model.startsWith('bytedance-seed/');
}

export const seed_20_pro_free_model: KiloFreeModel = {
  public_id: 'bytedance-seed/dola-seed-2.0-pro:free',
  display_name: 'ByteDance Seed: Dola Seed 2.0 Pro (free)',
  description:
    "Built for the Agent era, it delivers stable performance in complex reasoning and long-horizon tasks, including multi-step planning, visual-text reasoning, video understanding, and advanced analysis. **Note:** For the free endpoint, all prompts and output are logged to improve the provider's model and its product and services. Please do not upload any personal, confidential, or otherwise sensitive information.",
  context_length: 256_000,
  max_completion_tokens: 128_000,
  status: 'disabled',
  flags: ['reasoning', 'prompt_cache', 'vision'],
  gateway: 'bytedance',
  internal_id: 'seed-2-0-pro-260328',
  inference_provider: 'seed',
};

export function applyByteDanceProviderSettings(requestToMutate: GatewayRequest) {
  if (requestToMutate.kind === 'chat_completions' || requestToMutate.kind === 'responses') {
    requestToMutate.body.thinking = { type: 'enabled' };
  }

  if (requestToMutate.kind === 'responses') {
    delete requestToMutate.body.prompt_cache_key;
    delete requestToMutate.body.safety_identifier;
    delete requestToMutate.body.user;
    delete requestToMutate.body.provider;
  }
}
