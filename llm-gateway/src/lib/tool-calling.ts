// Tool-calling utilities — direct port of src/lib/tool-calling.ts.
// Uses Web Crypto (crypto.subtle) instead of Node.js crypto.hash for CF Workers.

import type { OpenRouterChatCompletionRequest, ChatMessage } from '../types/request';

type ToolCall = { id: string; type: string; function?: { name?: string } };
type AssistantMessage = ChatMessage & { role: 'assistant'; tool_calls?: ToolCall[] };
type ToolMessage = ChatMessage & { role: 'tool'; tool_call_id: string };

function isAssistantMessage(msg: ChatMessage): msg is AssistantMessage {
  return msg.role === 'assistant';
}

function isToolMessage(msg: ChatMessage): msg is ToolMessage {
  return msg.role === 'tool' && typeof (msg as Record<string, unknown>).tool_call_id === 'string';
}

async function hashToolCallId(
  toolCallId: string,
  maxIdLength: number | undefined
): Promise<string> {
  const data = new TextEncoder().encode(toolCallId);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return maxIdLength !== undefined ? hex.slice(0, maxIdLength) : hex;
}

export function dropToolStrictProperties(requestToMutate: OpenRouterChatCompletionRequest) {
  for (const tool of (requestToMutate.tools ?? []) as Array<{
    type?: string;
    function?: { strict?: unknown };
  }>) {
    if (tool.type === 'function' && tool.function) {
      delete tool.function.strict;
    }
  }
}

export async function normalizeToolCallIds(
  requestToMutate: OpenRouterChatCompletionRequest,
  filter: (toolCallId: string) => boolean,
  maxIdLength: number | undefined
): Promise<void> {
  for (const msg of requestToMutate.messages) {
    if (isAssistantMessage(msg)) {
      for (const toolCall of msg.tool_calls ?? []) {
        if (filter(toolCall.id)) {
          toolCall.id = await hashToolCallId(toolCall.id, maxIdLength);
        }
      }
    }
    if (isToolMessage(msg) && filter(msg.tool_call_id)) {
      msg.tool_call_id = await hashToolCallId(msg.tool_call_id, maxIdLength);
    }
  }
}

export function hasAttemptCompletionTool(request: OpenRouterChatCompletionRequest): boolean {
  return ((request.tools ?? []) as Array<{ type?: string; function?: { name?: string } }>).some(
    tool => tool.type === 'function' && tool.function?.name === 'attempt_completion'
  );
}

function groupByAssistantMessage(messages: ChatMessage[]) {
  const groups: Array<{
    assistantMessage?: AssistantMessage;
    otherMessages: ChatMessage[];
  }> = [{ assistantMessage: undefined, otherMessages: [] }];

  for (const msg of messages) {
    if (isAssistantMessage(msg)) {
      groups.push({ assistantMessage: msg, otherMessages: [] });
    } else {
      const lastGroup = groups.at(-1);
      if (lastGroup) lastGroup.otherMessages.push(msg);
    }
  }

  return groups;
}

function deduplicateToolUses(assistantMessage: AssistantMessage) {
  if (!assistantMessage.tool_calls) return;
  const seen = new Set<string>();
  assistantMessage.tool_calls = assistantMessage.tool_calls.filter(tc => {
    if (seen.has(tc.id)) {
      console.warn(`[repairTools] removing duplicate tool call id ${tc.id}`);
      return false;
    }
    seen.add(tc.id);
    return true;
  });
}

export const ENABLE_TOOL_REPAIR = true;

export function repairTools(requestToMutate: OpenRouterChatCompletionRequest) {
  if (!Array.isArray(requestToMutate.messages)) return;
  const groups = groupByAssistantMessage(requestToMutate.messages);

  for (const group of groups) {
    if (group.assistantMessage) {
      deduplicateToolUses(group.assistantMessage);
    }

    const toolCallIds = new Set<string>();
    const missingResults: ToolMessage[] = [];

    for (const tc of group.assistantMessage?.tool_calls ?? []) {
      toolCallIds.add(tc.id);
      if (group.otherMessages.some(m => isToolMessage(m) && m.tool_call_id === tc.id)) continue;
      const name = tc.function?.name ?? 'unknown';
      console.warn(`[repairTools] inserting missing result for tool ${name} id ${tc.id}`);
      missingResults.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: 'Tool execution was interrupted before completion.',
      });
    }
    group.otherMessages.splice(0, 0, ...missingResults);

    group.otherMessages = group.otherMessages.filter(msg => {
      if (isToolMessage(msg) && !toolCallIds.delete(msg.tool_call_id)) {
        console.warn(`[repairTools] deleting orphan tool result for id ${msg.tool_call_id}`);
        return false;
      }
      return true;
    });
  }

  requestToMutate.messages = groups.flatMap(g =>
    g.assistantMessage ? [g.assistantMessage, ...g.otherMessages] : g.otherMessages
  );
}
