// Tests for tool-calling utilities: repairTools, dropToolStrictProperties,
// normalizeToolCallIds, hasAttemptCompletionTool.

import { describe, it, expect } from 'vitest';
import {
  repairTools,
  dropToolStrictProperties,
  normalizeToolCallIds,
  hasAttemptCompletionTool,
} from '../../src/lib/tool-calling';
import type { OpenRouterChatCompletionRequest } from '../../src/types/request';

function makeRequest(
  messages: Array<Record<string, unknown>>,
  tools?: Array<Record<string, unknown>>
): OpenRouterChatCompletionRequest {
  return { model: 'test', messages, tools } as unknown as OpenRouterChatCompletionRequest;
}

describe('repairTools', () => {
  it('deduplicates tool calls with same id', () => {
    const req = makeRequest([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'tc-1', type: 'function', function: { name: 'foo' } },
          { id: 'tc-1', type: 'function', function: { name: 'foo' } },
          { id: 'tc-2', type: 'function', function: { name: 'bar' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tc-1', content: 'result1' },
      { role: 'tool', tool_call_id: 'tc-2', content: 'result2' },
    ]);
    repairTools(req);
    const assistant = req.messages.find(m => m.role === 'assistant') as Record<string, unknown>;
    const toolCalls = assistant.tool_calls as Array<{ id: string }>;
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map(tc => tc.id)).toEqual(['tc-1', 'tc-2']);
  });

  it('inserts missing tool results', () => {
    const req = makeRequest([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'tc-1', type: 'function', function: { name: 'foo' } },
          { id: 'tc-2', type: 'function', function: { name: 'bar' } },
        ],
      },
      // Only result for tc-1; tc-2 is missing
      { role: 'tool', tool_call_id: 'tc-1', content: 'ok' },
    ]);
    repairTools(req);
    const toolMessages = req.messages.filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    const missing = toolMessages.find(
      m => (m as Record<string, unknown>).tool_call_id === 'tc-2'
    ) as Record<string, unknown>;
    expect(missing).toBeDefined();
    expect(missing.content).toContain('interrupted');
  });

  it('removes orphan tool results', () => {
    const req = makeRequest([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'foo' } }],
      },
      { role: 'tool', tool_call_id: 'tc-1', content: 'ok' },
      // Orphan — no corresponding tool_call
      { role: 'tool', tool_call_id: 'tc-999', content: 'orphan' },
    ]);
    repairTools(req);
    const toolMessages = req.messages.filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect((toolMessages[0] as Record<string, unknown>).tool_call_id).toBe('tc-1');
  });

  it('handles empty messages gracefully', () => {
    const req = makeRequest([]);
    repairTools(req);
    expect(req.messages).toEqual([]);
  });
});

describe('dropToolStrictProperties', () => {
  it('removes strict from function tool definitions', () => {
    const req = makeRequest(
      [{ role: 'user', content: 'hi' }],
      [
        { type: 'function', function: { name: 'foo', strict: true, parameters: {} } },
        { type: 'function', function: { name: 'bar', strict: false, parameters: {} } },
      ]
    );
    dropToolStrictProperties(req);
    const tools = req.tools as Array<{ function?: { strict?: unknown } }>;
    expect(tools[0].function?.strict).toBeUndefined();
    expect(tools[1].function?.strict).toBeUndefined();
  });
});

describe('normalizeToolCallIds', () => {
  it('hashes tool call IDs matching the filter', async () => {
    const req = makeRequest([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'long-id-that-needs-hashing', type: 'function', function: { name: 'foo' } },
          { id: 'short', type: 'function', function: { name: 'bar' } },
        ],
      },
      { role: 'tool', tool_call_id: 'long-id-that-needs-hashing', content: 'ok' },
      { role: 'tool', tool_call_id: 'short', content: 'ok' },
    ]);
    // Only hash IDs longer than 10 characters
    await normalizeToolCallIds(req, id => id.length > 10, 24);
    const assistant = req.messages.find(m => m.role === 'assistant') as Record<string, unknown>;
    const toolCalls = assistant.tool_calls as Array<{ id: string }>;
    // The long one should be hashed (24 hex chars)
    expect(toolCalls[0].id).toHaveLength(24);
    expect(toolCalls[0].id).not.toBe('long-id-that-needs-hashing');
    // The short one stays unchanged
    expect(toolCalls[1].id).toBe('short');
    // Tool result should also be updated
    const toolMsgs = req.messages.filter(m => m.role === 'tool') as Array<Record<string, unknown>>;
    expect(toolMsgs[0].tool_call_id).toBe(toolCalls[0].id);
    expect(toolMsgs[1].tool_call_id).toBe('short');
  });
});

describe('hasAttemptCompletionTool', () => {
  it('returns true when attempt_completion tool is present', () => {
    const req = makeRequest(
      [{ role: 'user', content: 'hi' }],
      [{ type: 'function', function: { name: 'attempt_completion' } }]
    );
    expect(hasAttemptCompletionTool(req)).toBe(true);
  });

  it('returns false when attempt_completion tool is absent', () => {
    const req = makeRequest(
      [{ role: 'user', content: 'hi' }],
      [{ type: 'function', function: { name: 'other_tool' } }]
    );
    expect(hasAttemptCompletionTool(req)).toBe(false);
  });

  it('returns false when no tools at all', () => {
    const req = makeRequest([{ role: 'user', content: 'hi' }]);
    expect(hasAttemptCompletionTool(req)).toBe(false);
  });
});
