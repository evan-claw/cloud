import { describe, it, expect } from 'vitest';
import { computeExpiration } from '../../src/lib/credit-expiration';

describe('computeExpiration', () => {
  const now = new Date('2026-03-04T12:00:00Z');
  const pastDate = '2026-03-01T00:00:00Z';
  const futureDate = '2026-04-01T00:00:00Z';

  it('expires a single fully unused credit', () => {
    const transactions = [
      {
        id: 'tx-1',
        amount_microdollars: 1_000_000,
        expiration_baseline_microdollars_used: 0,
        expiry_date: pastDate,
        description: 'Welcome credit',
        is_free: true,
      },
    ];
    const entity = { id: 'org-1', microdollars_used: 0 };
    const result = computeExpiration(transactions, entity, now, 'system');

    expect(result.newTransactions).toHaveLength(1);
    expect(result.newTransactions[0].amount_microdollars).toBe(-1_000_000);
    expect(result.newTransactions[0].credit_category).toBe('credits_expired');
    expect(result.newTransactions[0].original_transaction_id).toBe('tx-1');
  });

  it('expires a partially used credit (keeps used portion)', () => {
    const transactions = [
      {
        id: 'tx-1',
        amount_microdollars: 1_000_000,
        expiration_baseline_microdollars_used: 0,
        expiry_date: pastDate,
        description: 'Credit A',
        is_free: false,
      },
    ];
    const entity = { id: 'org-1', microdollars_used: 400_000 };
    const result = computeExpiration(transactions, entity, now, 'system');

    expect(result.newTransactions).toHaveLength(1);
    // 1M credit, 400k used → 600k expired
    expect(result.newTransactions[0].amount_microdollars).toBe(-600_000);
  });

  it('does not expire future-dated credits', () => {
    const transactions = [
      {
        id: 'tx-1',
        amount_microdollars: 1_000_000,
        expiration_baseline_microdollars_used: 0,
        expiry_date: futureDate,
        description: 'Future credit',
        is_free: true,
      },
    ];
    const entity = { id: 'org-1', microdollars_used: 0 };
    const result = computeExpiration(transactions, entity, now, 'system');

    expect(result.newTransactions).toHaveLength(0);
  });

  it('expires a fully used credit with zero expiration', () => {
    const transactions = [
      {
        id: 'tx-1',
        amount_microdollars: 500_000,
        expiration_baseline_microdollars_used: 0,
        expiry_date: pastDate,
        description: 'Fully used',
        is_free: true,
      },
    ];
    const entity = { id: 'org-1', microdollars_used: 1_000_000 };
    const result = computeExpiration(transactions, entity, now, 'system');

    expect(result.newTransactions).toHaveLength(1);
    expect(result.newTransactions[0].amount_microdollars).toBe(0);
  });

  it('adjusts baselines for overlapping credits', () => {
    const transactions = [
      {
        id: 'tx-1',
        amount_microdollars: 500_000,
        expiration_baseline_microdollars_used: 0,
        expiry_date: pastDate,
        description: 'First credit',
        is_free: true,
      },
      {
        id: 'tx-2',
        amount_microdollars: 500_000,
        expiration_baseline_microdollars_used: 0,
        expiry_date: pastDate,
        description: 'Second credit',
        is_free: true,
      },
    ];
    const entity = { id: 'org-1', microdollars_used: 300_000 };
    const result = computeExpiration(transactions, entity, now, 'system');

    expect(result.newTransactions).toHaveLength(2);
    // First credit: 500k, 300k used → 200k expired
    expect(result.newTransactions[0].amount_microdollars).toBe(-200_000);
    // Second credit: baseline adjusted by overlap → all 500k expired
    expect(result.newTransactions[1].amount_microdollars).toBe(-500_000);
    // Baseline for tx-2 should be adjusted
    expect(result.newBaselines.get('tx-2')).toBe(300_000);
  });

  it('handles null expiration_baseline_microdollars_used', () => {
    const transactions = [
      {
        id: 'tx-1',
        amount_microdollars: 1_000_000,
        expiration_baseline_microdollars_used: null,
        expiry_date: pastDate,
        description: 'No baseline',
        is_free: true,
      },
    ];
    const entity = { id: 'org-1', microdollars_used: 0 };
    const result = computeExpiration(transactions, entity, now, 'system');

    expect(result.newTransactions).toHaveLength(1);
    expect(result.newTransactions[0].amount_microdollars).toBe(-1_000_000);
  });
});
