import type { ParsedProxyRequest } from '@/lib/providers/openrouter/types';

export function isQwenModel(requestedModelId: string) {
  return requestedModelId.startsWith('qwen/');
}

export function applyQwenModelSettings(requestToMutate: ParsedProxyRequest) {
  // Max Output listed on OpenRouter is wrong
  if (requestToMutate.kind === 'chat_completions') {
    if (requestToMutate.body.max_tokens) {
      requestToMutate.body.max_tokens = Math.min(requestToMutate.body.max_tokens, 32768);
    }
    if (requestToMutate.body.max_completion_tokens) {
      requestToMutate.body.max_completion_tokens = Math.min(
        requestToMutate.body.max_completion_tokens,
        32768
      );
    }
  }
}
