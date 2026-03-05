// Workaround for @openrouter/ai-sdk-provider v1 duplicating reasoning.
// Port of src/lib/providers/fixOpenCodeDuplicateReasoning.ts.

import { ReasoningDetailType } from './custom-llm/reasoning-details';
import type { ReasoningDetailUnion } from './custom-llm/reasoning-details';
import type { OpenRouterChatCompletionRequest } from '../types/request';
import type { FraudDetectionHeaders } from './extract-headers';

type MessageWithReasoning = {
  reasoning_details?: ReasoningDetailUnion[];
};

export function isOpenCodeBasedClient(fraudHeaders: FraudDetectionHeaders): boolean {
  return !!fraudHeaders.http_user_agent?.startsWith('opencode-kilo-provider');
}

export function isRooCodeBasedClient(fraudHeaders: FraudDetectionHeaders): boolean {
  return !!fraudHeaders.http_user_agent?.startsWith('Kilo-Code/');
}

function isAnthropicModel(model: string): boolean {
  return model.startsWith('anthropic/');
}

export function fixOpenCodeDuplicateReasoning(
  requestedModel: string,
  request: OpenRouterChatCompletionRequest,
  sessionId: string | undefined
) {
  console.debug(
    `[fixOpenCodeDuplicateReasoning] start, model: ${requestedModel}, session: ${sessionId || 'unknown'}`
  );
  for (const msg of request.messages) {
    const msgWithReasoning = msg as MessageWithReasoning;
    if (!msgWithReasoning.reasoning_details) {
      continue;
    }
    const encryptedDataSet = new Set<string>();
    const textSet = new Set<string>();
    msgWithReasoning.reasoning_details = msgWithReasoning.reasoning_details.filter(rd => {
      if (rd.type === ReasoningDetailType.Encrypted && rd.data) {
        if (!encryptedDataSet.has(rd.data)) {
          encryptedDataSet.add(rd.data);
          return true;
        }
        console.debug(
          `[fixOpenCodeDuplicateReasoning] removing duplicated encrypted reasoning, model: ${requestedModel}, session: ${sessionId || 'unknown'}`
        );
        return false;
      }
      if (rd.type === ReasoningDetailType.Text && rd.text) {
        if (isAnthropicModel(requestedModel) && !rd.signature) {
          console.debug(
            `[fixOpenCodeDuplicateReasoning] removing reasoning text without signature, model: ${requestedModel}, session: ${sessionId || 'unknown'}`
          );
          return false;
        }
        if (!textSet.has(rd.text)) {
          textSet.add(rd.text);
          return true;
        }
        console.debug(
          `[fixOpenCodeDuplicateReasoning] removing duplicated reasoning text, model: ${requestedModel}, session: ${sessionId || 'unknown'}`
        );
        return false;
      }
      return true;
    });
  }
}
