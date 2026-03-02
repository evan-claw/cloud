// Tests for promotions: isActiveReviewPromo, isActiveCloudAgentPromo.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { isActiveReviewPromo, isActiveCloudAgentPromo } from '../../src/lib/promotions';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isActiveReviewPromo', () => {
  it('returns false for non-reviewer botId', () => {
    expect(isActiveReviewPromo('other', 'anthropic/claude-sonnet-4.6')).toBe(false);
  });

  it('returns false for wrong model', () => {
    expect(isActiveReviewPromo('reviewer', 'anthropic/claude-sonnet-4-20250514')).toBe(false);
  });

  it('returns false for undefined botId', () => {
    expect(isActiveReviewPromo(undefined, 'anthropic/claude-sonnet-4.6')).toBe(false);
  });

  it('returns false when promo has ended', () => {
    // The promo ends at 2026-02-25T14:00:00Z — mock a date after that
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
    expect(isActiveReviewPromo('reviewer', 'anthropic/claude-sonnet-4.6')).toBe(false);
    vi.useRealTimers();
  });

  it('returns true when promo is active', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-20T00:00:00Z'));
    expect(isActiveReviewPromo('reviewer', 'anthropic/claude-sonnet-4.6')).toBe(true);
    vi.useRealTimers();
  });
});

describe('isActiveCloudAgentPromo', () => {
  it('returns false for non-cloud-agent tokenSource', () => {
    expect(isActiveCloudAgentPromo('other', 'anthropic/claude-sonnet-4.6')).toBe(false);
  });

  it('returns false for wrong model', () => {
    expect(isActiveCloudAgentPromo('cloud-agent', 'anthropic/claude-3-5-sonnet')).toBe(false);
  });

  it('returns false before promo start', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-25T00:00:00Z'));
    expect(isActiveCloudAgentPromo('cloud-agent', 'anthropic/claude-sonnet-4.6')).toBe(false);
    vi.useRealTimers();
  });

  it('returns true during promo window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-27T00:00:00Z'));
    expect(isActiveCloudAgentPromo('cloud-agent', 'anthropic/claude-sonnet-4.6')).toBe(true);
    vi.useRealTimers();
  });

  it('returns false after promo end', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
    expect(isActiveCloudAgentPromo('cloud-agent', 'anthropic/claude-sonnet-4.6')).toBe(false);
    vi.useRealTimers();
  });
});
