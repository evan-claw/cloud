import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { GatewayRequest } from '@/lib/providers/openrouter/types';

export const corethink_free_model: KiloFreeModel = {
  public_id: 'corethink:free',
  display_name: 'CoreThink (free)',
  description:
    'CoreThink - AI that reasons through problems instead of guessing. Available free of charge in Kilo for a limited time.',
  context_length: 78_000,
  max_completion_tokens: 8192,
  status: 'public',
  flags: [],
  gateway: 'corethink',
  internal_id: 'corethink',
  inference_provider: 'corethink',
};

export function applyCoreThinkProviderSettings(requestToMutate: GatewayRequest) {
  if (requestToMutate.kind !== 'chat_completions') {
    // responses api is likely not supported
    return;
  }
  delete requestToMutate.body.transforms;
  delete requestToMutate.body.prompt_cache_key;
  delete requestToMutate.body.safety_identifier;
  delete requestToMutate.body.description;
  delete requestToMutate.body.usage;
  for (const message of requestToMutate.body.messages) {
    if ('reasoning' in message) {
      delete message.reasoning;
    }
    if ('reasoning_details' in message) {
      delete message.reasoning_details;
    }
  }
}
