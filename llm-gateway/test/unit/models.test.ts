import { describe, it, expect } from 'vitest';
import {
  isFreeModel,
  isKiloFreeModel,
  isDeadFreeModel,
  isRateLimitedToDeath,
} from '../../src/lib/models';

describe('isFreeModel', () => {
  it('recognises enabled Kilo-hosted free models', () => {
    expect(isFreeModel('giga-potato')).toBe(true);
    expect(isFreeModel('corethink:free')).toBe(true);
    expect(isFreeModel('minimax/minimax-m2.5:free')).toBe(true);
  });

  it('recognises generic :free suffix models', () => {
    expect(isFreeModel('meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
    expect(isFreeModel('openai/gpt-4o:free')).toBe(true);
  });

  it('recognises openrouter/free', () => {
    expect(isFreeModel('openrouter/free')).toBe(true);
  });

  it('recognises OpenRouter stealth models', () => {
    expect(isFreeModel('openrouter/some-model-alpha')).toBe(true);
    expect(isFreeModel('openrouter/some-model-beta')).toBe(true);
  });

  it('returns false for paid models', () => {
    expect(isFreeModel('anthropic/claude-3-5-sonnet')).toBe(false);
    expect(isFreeModel('openai/gpt-4o')).toBe(false);
  });

  // Disabled Kilo free models still match the generic :free suffix rule
  it('still returns true for disabled Kilo free models (they end in :free)', () => {
    expect(isFreeModel('x-ai/grok-code-fast-1:optimized:free')).toBe(true);
  });
});

describe('isKiloFreeModel', () => {
  it('returns true only for enabled Kilo-hosted free models', () => {
    expect(isKiloFreeModel('giga-potato')).toBe(true);
    expect(isKiloFreeModel('corethink:free')).toBe(true);
  });

  it('returns false for generic :free models', () => {
    expect(isKiloFreeModel('meta-llama/llama-3.3-70b-instruct:free')).toBe(false);
  });

  it('returns false for disabled Kilo free models', () => {
    expect(isKiloFreeModel('x-ai/grok-code-fast-1:optimized:free')).toBe(false);
  });
});

describe('isDeadFreeModel', () => {
  it('returns true for disabled Kilo free models', () => {
    expect(isDeadFreeModel('x-ai/grok-code-fast-1:optimized:free')).toBe(true);
    expect(isDeadFreeModel('z-ai/glm-5:free')).toBe(true);
  });

  it('returns false for enabled models', () => {
    expect(isDeadFreeModel('giga-potato')).toBe(false);
    expect(isDeadFreeModel('anthropic/claude-3-5-sonnet')).toBe(false);
  });
});

describe('isRateLimitedToDeath', () => {
  it('returns true for known rate-limited models', () => {
    expect(isRateLimitedToDeath('meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
    expect(isRateLimitedToDeath('deepseek/deepseek-r1-0528:free')).toBe(true);
  });

  it('returns false for models not in the list', () => {
    expect(isRateLimitedToDeath('anthropic/claude-3-5-sonnet')).toBe(false);
    expect(isRateLimitedToDeath('giga-potato')).toBe(false);
  });
});
