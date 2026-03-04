// Tests for maybePerformOrganizationAutoTopUp threshold check logic.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({}),
}));

const { maybePerformOrganizationAutoTopUp } = await import('../../src/lib/auto-top-up');

function makeFakeDb(opts: {
  lockResult?: { id: string } | undefined;
  freshOrg?: { total_microdollars_acquired: number; microdollars_used: number } | undefined;
}) {
  const calls: { table: string; method: string }[] = [];
  const updateChain = {
    set: () => ({
      where: () => ({
        returning: async () => {
          calls.push({ table: 'auto_top_up_configs', method: 'update' });
          return opts.lockResult ? [opts.lockResult] : [];
        },
      }),
    }),
  };
  const selectChain = {
    from: () => ({
      where: () => ({
        limit: async () => {
          calls.push({ table: 'organizations', method: 'select' });
          return opts.freshOrg ? [opts.freshOrg] : [];
        },
      }),
    }),
  };

  return {
    db: {
      update: () => updateChain,
      select: () => selectChain,
    } as never,
    calls,
  };
}

describe('maybePerformOrganizationAutoTopUp', () => {
  it('skips when auto_top_up_enabled is false', async () => {
    const { db, calls } = makeFakeDb({});
    await maybePerformOrganizationAutoTopUp(db, {
      id: 'org-1',
      auto_top_up_enabled: false,
      total_microdollars_acquired: 1_000_000,
      microdollars_used: 999_000,
    });
    // Should not touch the DB at all
    expect(calls).toHaveLength(0);
  });

  it('skips when balance is above threshold ($5)', async () => {
    const { db, calls } = makeFakeDb({});
    await maybePerformOrganizationAutoTopUp(db, {
      id: 'org-1',
      auto_top_up_enabled: true,
      total_microdollars_acquired: 100_000_000, // $100
      microdollars_used: 90_000_000, // $90 used → $10 balance
    });
    // $10 > $5 threshold, so no DB operations
    expect(calls).toHaveLength(0);
  });

  it('attempts lock acquisition when balance is below threshold', async () => {
    const { db, calls } = makeFakeDb({
      lockResult: { id: 'config-1' },
      freshOrg: {
        total_microdollars_acquired: 10_000_000,
        microdollars_used: 8_000_000, // $2 balance < $5 threshold
      },
    });
    await maybePerformOrganizationAutoTopUp(db, {
      id: 'org-1',
      auto_top_up_enabled: true,
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 8_000_000, // $2 balance
    });
    // Should acquire lock + re-check balance
    expect(calls).toEqual([
      { table: 'auto_top_up_configs', method: 'update' },
      { table: 'organizations', method: 'select' },
    ]);
  });

  it('releases lock when fresh balance is sufficient', async () => {
    const updateCalls: { attempt_started_at: unknown }[] = [];
    const db = {
      update: () => ({
        set: (val: Record<string, unknown>) => {
          updateCalls.push({ attempt_started_at: val.attempt_started_at });
          return {
            where: () => ({
              // returning() is only called on the lock-acquisition path
              returning: async () => [{ id: 'config-1' }],
            }),
          };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                total_microdollars_acquired: 100_000_000, // $100
                microdollars_used: 0, // $100 balance
              },
            ],
          }),
        }),
      }),
    } as never;

    await maybePerformOrganizationAutoTopUp(db, {
      id: 'org-1',
      auto_top_up_enabled: true,
      total_microdollars_acquired: 5_000_000,
      microdollars_used: 4_500_000, // $0.50 initial
    });

    // First call: lock acquisition (sets attempt_started_at to NOW())
    // Second call: lock release (sets attempt_started_at to null)
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[1].attempt_started_at).toBeNull();
  });
});
