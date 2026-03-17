import { ReasoningDetailType } from '@/lib/custom-llm/reasoning-details';
import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type {
  GatewayRequest,
  MessageWithReasoning,
  OpenRouterChatCompletionRequest,
} from '@/lib/providers/openrouter/types';

export const qwen35_plus_free_model: KiloFreeModel = {
  public_id: 'qwen/qwen3.5-plus:free',
  display_name: 'Qwen: Qwen3.5 Plus (free)',
  description:
    'The Qwen3.5 native vision-language series Plus models are built on a hybrid architecture that integrates linear attention mechanisms with sparse mixture-of-experts models, achieving higher inference efficiency. In a variety of task evaluations, the 3.5 series consistently demonstrates performance on par with state-of-the-art leading models. Compared to the 3 series, these models show a leap forward in both pure-text and multimodal capabilities.',
  context_length: 1000000,
  max_completion_tokens: 65536,
  status: 'disabled',
  flags: ['reasoning', 'prompt_cache', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.5-plus',
  inference_provider: 'alibaba',
};

export function isQwenModel(requestedModelId: string) {
  return requestedModelId.startsWith('qwen/');
}

export function convertReasoningDetailsToReasoningContent(
  requestToMutate: OpenRouterChatCompletionRequest
) {
  for (const message of requestToMutate.messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    const msgWithReasoning = message as MessageWithReasoning;
    const reasoningDetailsText = (msgWithReasoning.reasoning_details ?? [])
      .filter(r => r.type === ReasoningDetailType.Text)
      .map(r => r.text)
      .join('');
    if (reasoningDetailsText) {
      msgWithReasoning.reasoning_content = reasoningDetailsText;
      delete msgWithReasoning.reasoning_details;
      delete msgWithReasoning.reasoning;
    }
  }
}

export function applyAlibabaProviderSettings(requestToMutate: GatewayRequest) {
  if (requestToMutate.kind === 'chat_completions') {
    convertReasoningDetailsToReasoningContent(requestToMutate.body);
  }
}
