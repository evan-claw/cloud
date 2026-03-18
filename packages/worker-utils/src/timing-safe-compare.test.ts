import { describe, it, expect, beforeAll } from 'vitest';
import { timingSafeEqual as nodeCryptoTimingSafeEqual } from 'node:crypto';
import { timingSafeCompare } from './timing-safe-compare.js';

// crypto.subtle.timingSafeEqual is a Cloudflare Workers extension; polyfill for Node vitest.
beforeAll(() => {
  if (!('timingSafeEqual' in crypto.subtle)) {
    Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
      value: (a: ArrayBuffer, b: ArrayBuffer) =>
        nodeCryptoTimingSafeEqual(new Uint8Array(a), new Uint8Array(b)),
      configurable: true,
    });
  }
});

describe('timingSafeCompare', () => {
  it('returns true for equal strings', async () => {
    expect(await timingSafeCompare('secret', 'secret')).toBe(true);
  });

  it('returns false for unequal strings of the same length', async () => {
    expect(await timingSafeCompare('secretA', 'secretB')).toBe(false);
  });

  it('returns false for strings of different lengths', async () => {
    expect(await timingSafeCompare('short', 'much-longer-string')).toBe(false);
  });

  it('returns true for empty strings', async () => {
    expect(await timingSafeCompare('', '')).toBe(true);
  });

  it('returns false when one string is empty', async () => {
    expect(await timingSafeCompare('', 'nonempty')).toBe(false);
  });
});
