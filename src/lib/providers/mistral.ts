import type { ParsedProxyRequest } from '@/lib/providers/openrouter/types';
import {
  dropToolStrictProperties,
  hasAttemptCompletionTool,
  normalizeToolCallIds,
} from '@/lib/tool-calling';

export function isMistralModel(model: string) {
  return model.startsWith('mistralai/');
}
export function isCodestralModel(model: string) {
  return model.startsWith('mistralai/codestral');
}

export function applyMistralModelSettings(requestToMutate: ParsedProxyRequest) {
  if (requestToMutate.kind !== 'chat_completions') {
    return;
  }

  // mistral recommends this
  // https://kilo-code.slack.com/archives/C09PV151JMN/p1764597849596819
  if (requestToMutate.body.temperature === undefined) {
    requestToMutate.body.temperature = 0.2;
  }

  // mistral requires tool call ids to be of length 9
  normalizeToolCallIds(requestToMutate.body, toolCallId => toolCallId.length !== 9, 9);

  // mistral doesn't support strict for our schema
  dropToolStrictProperties(requestToMutate.body);

  if (hasAttemptCompletionTool(requestToMutate.body)) {
    requestToMutate.body.tool_choice = 'required';
  }
}

export function applyMistralProviderSettings(
  requestToMutate: ParsedProxyRequest,
  extraHeaders: Record<string, string>
) {
  if (requestToMutate.kind !== 'chat_completions') {
    return;
  }

  // https://kilo-code.slack.com/archives/C09PV151JMN/p1764256100573969?thread_ts=1764179992.347349&cid=C09PV151JMN
  if (requestToMutate.body.prompt_cache_key) {
    extraHeaders['x-affinity'] = requestToMutate.body.prompt_cache_key;
  }

  // the stuff below is not supported by mistral and causes an error
  for (const message of requestToMutate.body.messages) {
    if ('reasoning_details' in message) {
      delete message.reasoning_details;
    }
  }
  delete requestToMutate.body.reasoning;
  delete requestToMutate.body.reasoning_effort;
  delete requestToMutate.body.transforms;
  delete requestToMutate.body.safety_identifier;
  delete requestToMutate.body.prompt_cache_key;
  delete requestToMutate.body.user;
  delete requestToMutate.body.provider;

  applyMistralModelSettings(requestToMutate);
}
