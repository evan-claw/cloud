// Prompt info extraction and token estimation.
// Port of src/lib/processUsage.ts (extractPromptInfo) and
// src/lib/llm-proxy-helpers.ts (estimateChatTokens).

import type { OpenRouterChatCompletionRequest } from '../types/request';

export type PromptInfo = {
  system_prompt_prefix: string;
  system_prompt_length: number;
  user_prompt_prefix: string;
};

type MessageContent = string | Array<{ type: string; text?: string }> | null | undefined;

export function extractMessageTextContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string'
      )
      .map(c => c.text)
      .join('');
  }
  return '';
}

export function extractPromptInfo(body: OpenRouterChatCompletionRequest): PromptInfo {
  try {
    const messages = body.messages ?? [];

    const systemPrompt = messages
      .filter(m => m.role === 'system' || m.role === 'developer')
      .map(m => extractMessageTextContent(m.content as MessageContent))
      .join('\n');

    const system_prompt_prefix = systemPrompt.slice(0, 100);
    const system_prompt_length = systemPrompt.length;

    const lastUserMessage =
      messages
        .filter(m => m.role === 'user')
        .slice(-1)
        .map(m => extractMessageTextContent(m.content as MessageContent))[0] ?? '';

    const user_prompt_prefix = lastUserMessage.slice(0, 100);

    return { system_prompt_prefix, system_prompt_length, user_prompt_prefix };
  } catch {
    return { system_prompt_prefix: '', system_prompt_length: -1, user_prompt_prefix: '' };
  }
}

export function estimateChatTokens(body: OpenRouterChatCompletionRequest): {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
} {
  if (!body.messages || !Array.isArray(body.messages)) {
    return { estimatedInputTokens: 0, estimatedOutputTokens: 0 };
  }
  const overallLength = body.messages.reduce((sum, m) => {
    const content = m.content;
    if (typeof content === 'string') return sum + content.length;
    if (Array.isArray(content)) {
      const textLength = content
        .filter(
          (c): c is { type: 'text'; text: string } =>
            typeof c === 'object' && c !== null && 'type' in c && c.type === 'text'
        )
        .reduce((l, c) => l + c.text.length + 1, 0);
      return sum + textLength;
    }
    return sum;
  }, 0);
  return {
    estimatedInputTokens: overallLength / 4,
    estimatedOutputTokens: overallLength / 4,
  };
}
