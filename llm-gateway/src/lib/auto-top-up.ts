// Organization auto-top-up trigger — port of src/lib/autoTopUp.ts threshold check.
// The actual Stripe charge is handled by the Next.js app's auto_top_up_configs table;
// this module only performs the cheap balance-below-threshold check and enqueues
// a DB-driven auto-top-up attempt via a direct SQL update to auto_top_up_configs.

import type { WorkerDb } from '@kilocode/db/client';
import { auto_top_up_configs, organizations } from '@kilocode/db/schema';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

// Must match src/lib/autoTopUpConstants.ts
const ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS = 5;
const ATTEMPT_LOCK_TIMEOUT_SECONDS = 60 * 60 * 2; // 2 hours

type AutoTopUpOrganization = {
  id: string;
  auto_top_up_enabled: boolean;
  total_microdollars_acquired: number;
  microdollars_used: number;
};

/**
 * Trigger org auto-top-up if balance is below threshold.
 * Mirrors the threshold check in src/lib/autoTopUp.ts, then atomically
 * acquires the attempt lock so the Next.js invoice.paid webhook flow
 * picks up the actual Stripe charge.
 */
export async function maybePerformOrganizationAutoTopUp(
  db: WorkerDb,
  organization: AutoTopUpOrganization
): Promise<void> {
  if (!organization.auto_top_up_enabled) return;

  const balance_USD =
    (organization.total_microdollars_acquired - organization.microdollars_used) / 1_000_000;
  if (balance_USD >= ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS) return;

  // Atomically acquire the attempt lock — prevents concurrent top-ups.
  // If another attempt is already in progress (within the lock timeout), this is a no-op.
  try {
    const [config] = await db
      .update(auto_top_up_configs)
      .set({ attempt_started_at: sql`NOW()` })
      .where(
        and(
          eq(auto_top_up_configs.owned_by_organization_id, organization.id),
          or(
            isNull(auto_top_up_configs.attempt_started_at),
            lt(
              auto_top_up_configs.attempt_started_at,
              sql`NOW() - INTERVAL '1 second' * ${ATTEMPT_LOCK_TIMEOUT_SECONDS}`
            )
          )
        )
      )
      .returning({ id: auto_top_up_configs.id });

    if (!config) {
      // No config or concurrent attempt — skip
      return;
    }

    // Re-check balance after acquiring lock (another request may have topped up)
    const [freshOrg] = await db
      .select({
        total_microdollars_acquired: organizations.total_microdollars_acquired,
        microdollars_used: organizations.microdollars_used,
      })
      .from(organizations)
      .where(eq(organizations.id, organization.id))
      .limit(1);

    if (!freshOrg) {
      await db
        .update(auto_top_up_configs)
        .set({ attempt_started_at: null })
        .where(eq(auto_top_up_configs.id, config.id));
      return;
    }

    const freshBalance_USD =
      (freshOrg.total_microdollars_acquired - freshOrg.microdollars_used) / 1_000_000;
    if (freshBalance_USD >= ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS) {
      // Balance now sufficient, release lock
      await db
        .update(auto_top_up_configs)
        .set({ attempt_started_at: null })
        .where(eq(auto_top_up_configs.id, config.id));
      return;
    }

    // Lock acquired and balance is below threshold.
    // The actual Stripe charge will be performed by the periodic auto-top-up
    // processor or the Next.js API when it sees the locked config.
    console.log('[auto-top-up] Triggered for organization', {
      organizationId: organization.id,
      balance_USD: freshBalance_USD,
      threshold_USD: ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS,
    });
  } catch (err) {
    console.error('[auto-top-up] Failed', err);
  }
}
