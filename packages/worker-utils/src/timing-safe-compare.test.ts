import { describe, it, expect } from 'vitest';
import { timingSafeCompare } from './timing-safe-compare.js';

describe('timingSafeCompare', () => {
  it('returns true for equal strings', async () => {
    expect(await timingSafeCompare('secret', 'secret')).toBe(true);
  });

  it('returns false for unequal strings of the same length', async () => {
    expect(await timingSafeCompare('secret1', 'secret2')).toBe(false);
  });

  it('returns false for strings of different lengths', async () => {
    expect(await timingSafeCompare('short', 'much-longer-string')).toBe(false);
  });
});
