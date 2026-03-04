import { describe, it, expect } from 'vitest';
import { isKiloAutoModel, resolveAutoModel } from '../../src/lib/kilo-auto-model';

describe('isKiloAutoModel', () => {
  it('recognises kilo/auto variants', () => {
    expect(isKiloAutoModel('kilo/auto')).toBe(true);
    expect(isKiloAutoModel('kilo/auto-free')).toBe(true);
    expect(isKiloAutoModel('kilo/auto-small')).toBe(true);
  });

  it('returns false for real models', () => {
    expect(isKiloAutoModel('anthropic/claude-sonnet-4.6')).toBe(false);
    expect(isKiloAutoModel('openai/gpt-4o')).toBe(false);
  });
});

describe('resolveAutoModel', () => {
  it('resolves kilo/auto-free to minimax free model', () => {
    const result = resolveAutoModel('kilo/auto-free', null);
    expect(result.model).toBe('minimax/minimax-m2.5:free');
  });

  it('resolves kilo/auto-small to gpt-5-nano', () => {
    const result = resolveAutoModel('kilo/auto-small', null);
    expect(result.model).toBe('openai/gpt-5-nano');
  });

  it('resolves kilo/auto with plan mode to Claude Opus', () => {
    const result = resolveAutoModel('kilo/auto', 'plan');
    expect(result.model).toBe('anthropic/claude-opus-4.6');
  });

  it('resolves kilo/auto with code mode to Claude Sonnet', () => {
    const result = resolveAutoModel('kilo/auto', 'code');
    expect(result.model).toBe('anthropic/claude-sonnet-4.6');
  });

  it('falls back to code model for unknown mode', () => {
    const result = resolveAutoModel('kilo/auto', 'unknown-mode');
    expect(result.model).toBe('anthropic/claude-sonnet-4.6');
  });

  it('falls back to code model when modeHeader is null', () => {
    const result = resolveAutoModel('kilo/auto', null);
    expect(result.model).toBe('anthropic/claude-sonnet-4.6');
  });
});
