// Tests for promotions: isActiveReviewPromo, isActiveCloudAgentPromo.
// Both promotions have expired — all calls return false regardless of input.

import { describe, it, expect } from 'vitest';
import { isActiveReviewPromo, isActiveCloudAgentPromo } from '../../src/lib/promotions';

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

  it('always returns false (promo expired 2026-02-25)', () => {
    expect(isActiveReviewPromo('reviewer', 'anthropic/claude-sonnet-4.6')).toBe(false);
  });
});

describe('isActiveCloudAgentPromo', () => {
  it('returns false for non-cloud-agent tokenSource', () => {
    expect(isActiveCloudAgentPromo('other', 'anthropic/claude-sonnet-4.6')).toBe(false);
  });

  it('returns false for wrong model', () => {
    expect(isActiveCloudAgentPromo('cloud-agent', 'anthropic/claude-3-5-sonnet')).toBe(false);
  });

  it('always returns false (promo expired 2026-02-28)', () => {
    expect(isActiveCloudAgentPromo('cloud-agent', 'anthropic/claude-sonnet-4.6')).toBe(false);
  });
});
