// Tests for prompt-info: extractPromptInfo, estimateChatTokens.

import { describe, it, expect } from 'vitest';
import { extractPromptInfo, estimateChatTokens } from '../../src/lib/prompt-info';

describe('extractPromptInfo', () => {
  it('extracts system and user prompt prefixes', () => {
    const result = extractPromptInfo({
      model: 'test',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the meaning of life?' },
      ],
    });
    expect(result.system_prompt_prefix).toBe('You are a helpful assistant.');
    expect(result.system_prompt_length).toBe(28);
    expect(result.user_prompt_prefix).toBe('What is the meaning of life?');
  });

  it('uses last user message for user_prompt_prefix', () => {
    const result = extractPromptInfo({
      model: 'test',
      messages: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second message' },
      ],
    });
    expect(result.user_prompt_prefix).toBe('second message');
  });

  it('handles multipart content arrays', () => {
    const result = extractPromptInfo({
      model: 'test',
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'System part 1' },
            { type: 'text', text: 'System part 2' },
          ],
        },
      ],
    });
    expect(result.system_prompt_prefix).toBe('System part 1System part 2');
  });

  it('truncates at 100 characters', () => {
    const long = 'a'.repeat(200);
    const result = extractPromptInfo({
      model: 'test',
      messages: [{ role: 'system', content: long }],
    });
    expect(result.system_prompt_prefix).toHaveLength(100);
    expect(result.system_prompt_length).toBe(200);
  });

  it('handles empty messages gracefully', () => {
    const result = extractPromptInfo({ model: 'test', messages: [] });
    expect(result.system_prompt_prefix).toBe('');
    expect(result.user_prompt_prefix).toBe('');
  });

  it('handles developer role as system', () => {
    const result = extractPromptInfo({
      model: 'test',
      messages: [{ role: 'developer', content: 'dev instructions' }],
    });
    expect(result.system_prompt_prefix).toBe('dev instructions');
  });
});

describe('estimateChatTokens', () => {
  it('estimates tokens at ~length/4', () => {
    // 40 chars → ~10 tokens
    const result = estimateChatTokens({
      model: 'test',
      messages: [{ role: 'user', content: 'a'.repeat(40) }],
    });
    expect(result.estimatedInputTokens).toBe(10);
    expect(result.estimatedOutputTokens).toBe(10);
  });

  it('sums across multiple messages', () => {
    const result = estimateChatTokens({
      model: 'test',
      messages: [
        { role: 'system', content: 'a'.repeat(100) },
        { role: 'user', content: 'b'.repeat(100) },
      ],
    });
    expect(result.estimatedInputTokens).toBe(50);
  });

  it('handles missing messages', () => {
    const result = estimateChatTokens({ model: 'test', messages: undefined as never });
    expect(result.estimatedInputTokens).toBe(0);
  });

  it('handles multipart content arrays', () => {
    const result = estimateChatTokens({
      model: 'test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a'.repeat(40) },
            { type: 'image_url', image_url: { url: 'data:...' } },
          ],
        },
      ],
    });
    // Only text parts count: 40 chars + 1 (join separator) = 41/4 ≈ 10.25
    expect(result.estimatedInputTokens).toBeCloseTo(10.25, 1);
  });
});
