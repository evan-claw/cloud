// Tests for anonymous context utilities.

import { describe, it, expect } from 'vitest';
import { createAnonymousContext, isAnonymousContext } from '../../src/lib/anonymous';

describe('createAnonymousContext', () => {
  it('creates context with synthetic user ID', () => {
    const ctx = createAnonymousContext('1.2.3.4');
    expect(ctx.id).toBe('anon:1.2.3.4');
    expect(ctx.isAnonymous).toBe(true);
    expect(ctx.ipAddress).toBe('1.2.3.4');
    expect(ctx.microdollars_used).toBe(0);
    expect(ctx.is_admin).toBe(false);
  });
});

describe('isAnonymousContext', () => {
  it('returns true for anonymous context', () => {
    const ctx = createAnonymousContext('1.2.3.4');
    expect(isAnonymousContext(ctx)).toBe(true);
  });

  it('returns false for regular user', () => {
    expect(isAnonymousContext({ id: 'user-1', isAnonymous: false })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isAnonymousContext(null)).toBe(false);
    expect(isAnonymousContext(undefined)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isAnonymousContext('string')).toBe(false);
    expect(isAnonymousContext(42)).toBe(false);
  });
});
