import type { GatewayRequest } from '@/lib/providers/openrouter/types';
import type OpenAI from 'openai';

export function getMaxTokens(request: GatewayRequest) {
  return request.kind === 'chat_completions'
    ? (request.body.max_completion_tokens ?? request.body.max_tokens ?? null)
    : (request.body.max_output_tokens ?? null);
}

export function hasMiddleOutTransform(request: GatewayRequest) {
  return (
    (request.kind === 'chat_completions' && request.body.transforms?.includes('middle-out')) ||
    false
  );
}

function setCacheControlOnChatCompletionsMessage(message: OpenAI.ChatCompletionMessageParam) {
  if (typeof message.content === 'string') {
    message.content = [
      {
        type: 'text',
        text: message.content,
        // @ts-expect-error non-standard extension
        cache_control: { type: 'ephemeral' },
      },
    ];
  } else if (Array.isArray(message.content)) {
    const lastItem = message.content.at(-1);
    if (lastItem) {
      // @ts-expect-error non-standard extension
      lastItem.cache_control = { type: 'ephemeral' };
    }
  }
}

function setCacheControlOnResponsesMessage(message: OpenAI.Responses.ResponseInputItem) {
  if (message.type === 'message') {
    if (typeof message.content === 'string') {
      message.content = [
        {
          type: 'input_text',
          text: message.content,
          // @ts-expect-error non-standard extension
          cache_control: { type: 'ephemeral' },
        },
      ];
    } else {
      const lastItem = message.content.at(-1);
      if (lastItem) {
        // @ts-expect-error non-standard extension
        lastItem.cache_control = { type: 'ephemeral' };
      }
    }
  } else if (message.type === 'function_call_output') {
    if (typeof message.output === 'string') {
      message.output = [
        {
          type: 'input_text',
          text: message.output,
          // @ts-expect-error non-standard extension
          cache_control: { type: 'ephemeral' },
        },
      ];
    } else {
      const lastItem = message.output.at(-1);
      if (lastItem) {
        // @ts-expect-error non-standard extension
        lastItem.cache_control = { type: 'ephemeral' };
      }
    }
  }
}

export function addCacheBreakpoints(request: GatewayRequest) {
  if (
    request.kind === 'chat_completions' &&
    Array.isArray(request.body.messages) &&
    request.body.messages.length > 1
  ) {
    const lastMessage = request.body.messages.findLast(
      msg => msg.role === 'user' || msg.role === 'tool'
    );
    if (lastMessage) {
      console.debug(
        `[addCacheBreakpoints] setting cache breakpoint on last ${lastMessage.role} chat completions message`
      );
      setCacheControlOnChatCompletionsMessage(lastMessage);
    }
  } else if (
    request.kind === 'responses' &&
    Array.isArray(request.body.input) &&
    request.body.input.length > 1
  ) {
    const lastMessage = request.body.input.findLast(
      msg => (msg.type === 'message' && msg.role === 'user') || msg.type === 'function_call_output'
    );
    if (lastMessage) {
      console.debug(
        `[addCacheBreakpoints] setting cache breakpoint on last ${lastMessage.type} responses message`
      );
      setCacheControlOnResponsesMessage(lastMessage);
    }
  }
}
