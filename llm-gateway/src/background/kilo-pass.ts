// KiloPass bonus credit issuance triggered by usage threshold.
// Port of src/lib/kilo-pass/usage-triggered-bonus.ts and related files.
//
// Simplified for CF Workers:
//   - No Sentry error captures (use console.error)
//   - No server-only imports
//   - Uses vanilla Date arithmetic instead of dayjs
//   - Direct credit grant (insert credit_transactions + update kilocode_users)
//     instead of processTopUp/grantCreditForCategory

import { sql, eq, and, ne, desc, inArray } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import {
  kilocode_users,
  kilo_pass_subscriptions,
  kilo_pass_issuances,
  kilo_pass_issuance_items,
  kilo_pass_audit_log,
  credit_transactions,
} from '@kilocode/db/schema';
import {
  KiloPassTier,
  KiloPassCadence,
  KiloPassIssuanceSource,
  KiloPassIssuanceItemKind,
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
} from '@kilocode/db/schema-types';

// ─── Constants ────────────────────────────────────────────────────────────────

const KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT = 0.5;
const KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT = 0.5;
const KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT = 0.5;
// First-time subscribers who started strictly before this cutoff get 50% bonus for first 2 months.
const KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF_ISO = '2026-03-07T07:59:59Z';

const KILO_PASS_MONTHLY_RAMP_BASE = 0.05;
const KILO_PASS_MONTHLY_RAMP_STEP = 0.05;
const KILO_PASS_MONTHLY_RAMP_CAP = 0.4;

const KILO_PASS_TIER_CONFIG: Record<KiloPassTier, { monthlyPriceUsd: number }> = {
  [KiloPassTier.Tier19]: { monthlyPriceUsd: 19 },
  [KiloPassTier.Tier49]: { monthlyPriceUsd: 49 },
  [KiloPassTier.Tier199]: { monthlyPriceUsd: 199 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getEffectiveKiloPassThreshold(threshold: number | null): number | null {
  if (threshold === null) return null;
  return Math.max(0, threshold - 1_000_000);
}

function toMicrodollars(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function roundUsdToCents(usd: number): number {
  return Math.round(usd * 100);
}

function centsToUsd(cents: number): number {
  return cents / 100;
}

/** Returns the YYYY-MM-01 string for the given UTC date. */
function computeIssueMonth(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/** Add months to a UTC date (handles month overflow correctly). */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** Parse an ISO string safely, returning null if invalid. */
function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function computeMonthlyCadenceBonusPercent(params: {
  tier: KiloPassTier;
  streakMonths: number;
  isFirstTimeSubscriberEver: boolean;
  subscriptionStartedAtIso: string | null;
}): number {
  const { streakMonths, isFirstTimeSubscriberEver, subscriptionStartedAtIso } = params;
  const streak = Math.max(1, streakMonths);

  if (streak <= 2 && isFirstTimeSubscriberEver) {
    const startedAt = parseIso(subscriptionStartedAtIso);
    const cutoff = new Date(KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF_ISO);
    if (startedAt && startedAt < cutoff) {
      return KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT;
    }
    if (streak === 1) {
      return KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT;
    }
  }

  const nMinus1 = streak - 1;
  const uncapped = KILO_PASS_MONTHLY_RAMP_BASE + KILO_PASS_MONTHLY_RAMP_STEP * nMinus1;
  return Math.min(KILO_PASS_MONTHLY_RAMP_CAP, uncapped);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type KiloPassSubscriptionState = {
  subscriptionId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentStreakMonths: number;
  nextYearlyIssueAt: string | null;
  startedAt: string | null;
};

type Tx = Parameters<WorkerDb['transaction']>[0] extends (tx: infer T) => unknown ? T : never;

// ─── DB helpers ───────────────────────────────────────────────────────────────

function getStatusPriority(row: { status: string; cancelAtPeriodEnd: boolean }): number {
  if (row.status === 'active' && !row.cancelAtPeriodEnd) return 0;
  if (row.status === 'active' && row.cancelAtPeriodEnd) return 1;
  if (row.status === 'trialing') return 2;
  if (row.status === 'past_due') return 3;
  if (row.status === 'paused') return 4;
  if (row.status === 'incomplete') return 5;
  const endedStatuses = ['incomplete_expired', 'canceled', 'unpaid'];
  if (endedStatuses.includes(row.status)) return 6;
  return 7;
}

async function getKiloPassStateForUser(
  tx: Tx,
  kiloUserId: string
): Promise<KiloPassSubscriptionState | null> {
  const rows = await tx
    .select({
      subscriptionId: kilo_pass_subscriptions.id,
      tier: kilo_pass_subscriptions.tier,
      cadence: kilo_pass_subscriptions.cadence,
      status: kilo_pass_subscriptions.status,
      cancelAtPeriodEnd: kilo_pass_subscriptions.cancel_at_period_end,
      currentStreakMonths: kilo_pass_subscriptions.current_streak_months,
      nextYearlyIssueAt: kilo_pass_subscriptions.next_yearly_issue_at,
      startedAt: kilo_pass_subscriptions.started_at,
    })
    .from(kilo_pass_subscriptions)
    .where(eq(kilo_pass_subscriptions.kilo_user_id, kiloUserId));

  if (rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => {
    const pd = getStatusPriority(a) - getStatusPriority(b);
    if (pd !== 0) return pd;
    const aMs = parseIso(a.startedAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bMs = parseIso(b.startedAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
    return bMs - aMs;
  });

  const s = sorted[0];
  if (!s) return null;
  return {
    subscriptionId: s.subscriptionId,
    tier: s.tier,
    cadence: s.cadence,
    status: s.status,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    currentStreakMonths: s.currentStreakMonths,
    nextYearlyIssueAt: s.nextYearlyIssueAt,
    startedAt: s.startedAt,
  };
}

async function clearKiloPassThreshold(tx: Tx, kiloUserId: string): Promise<void> {
  await tx
    .update(kilocode_users)
    .set({ kilo_pass_threshold: null })
    .where(eq(kilocode_users.id, kiloUserId));
}

/** Compute bonus expiry date for a given subscription and issuance. */
async function computeBonusExpiryDate(
  tx: Tx,
  issuanceId: string,
  subscriptionId: string
): Promise<Date | null> {
  const issuanceRows = await tx
    .select({ issueMonth: kilo_pass_issuances.issue_month })
    .from(kilo_pass_issuances)
    .where(eq(kilo_pass_issuances.id, issuanceId))
    .limit(1);
  const issueMonth = issuanceRows[0]?.issueMonth;
  if (!issueMonth) return null;

  const subRows = await tx
    .select({
      cadence: kilo_pass_subscriptions.cadence,
      nextYearlyIssueAt: kilo_pass_subscriptions.next_yearly_issue_at,
      startedAt: kilo_pass_subscriptions.started_at,
    })
    .from(kilo_pass_subscriptions)
    .where(eq(kilo_pass_subscriptions.id, subscriptionId))
    .limit(1);
  const sub = subRows[0];
  if (!sub) return null;

  if (sub.cadence === KiloPassCadence.Yearly) {
    return parseIso(sub.nextYearlyIssueAt);
  }

  if (sub.cadence === KiloPassCadence.Monthly) {
    const startedAt = parseIso(sub.startedAt);
    if (!startedAt) return null;
    const issueMonthStart = parseIso(`${issueMonth}T00:00:00.000Z`);
    if (!issueMonthStart) return null;
    // Compute months since start
    const startMonthStart = new Date(
      Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), 1)
    );
    const monthOffset = Math.round(
      (issueMonthStart.getTime() - startMonthStart.getTime()) / (30 * 24 * 60 * 60 * 1000)
    );
    if (monthOffset < 0) return null;
    const periodStart = addMonths(startedAt, monthOffset);
    return addMonths(periodStart, 1);
  }

  return null;
}

/** Grant bonus credits directly: insert credit_transaction + update user balance. */
async function grantBonusCredit(
  tx: Tx,
  params: {
    kiloUserId: string;
    amountMicrodollars: number;
    description: string;
    expiryDate: Date | null;
  }
): Promise<string> {
  const creditId = crypto.randomUUID();
  await tx.insert(credit_transactions).values({
    id: creditId,
    kilo_user_id: params.kiloUserId,
    amount_microdollars: params.amountMicrodollars,
    is_free: true,
    description: params.description,
    credit_category: 'kilo-pass-bonus',
    expiry_date: params.expiryDate?.toISOString() ?? null,
  });
  await tx
    .update(kilocode_users)
    .set({
      total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${params.amountMicrodollars}`,
    })
    .where(eq(kilocode_users.id, params.kiloUserId));
  return creditId;
}

/** Get or create an issuance header for a subscription+month. */
async function createOrGetIssuanceHeader(
  tx: Tx,
  subscriptionId: string,
  issueMonth: string
): Promise<string | null> {
  const insertResult = await tx
    .insert(kilo_pass_issuances)
    .values({
      kilo_pass_subscription_id: subscriptionId,
      issue_month: issueMonth,
      source: KiloPassIssuanceSource.Cron,
      stripe_invoice_id: null,
    })
    .onConflictDoNothing()
    .returning({ id: kilo_pass_issuances.id });

  if (insertResult[0]?.id) return insertResult[0].id;

  const existing = await tx
    .select({ id: kilo_pass_issuances.id })
    .from(kilo_pass_issuances)
    .where(
      and(
        eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId),
        eq(kilo_pass_issuances.issue_month, issueMonth)
      )
    )
    .limit(1);

  return existing[0]?.id ?? null;
}

/** Compute the current issuance month for a yearly subscription. */
function computeYearlyIssueMonth(
  nextYearlyIssueAtIso: string | null,
  startedAtIso: string | null
): string | null {
  const parsedNext = parseIso(nextYearlyIssueAtIso);
  const anchor = parsedNext ?? parseIso(startedAtIso);
  if (!anchor) return null;
  // currentPeriodStart = nextYearlyIssueAt - 1 month (or startedAt)
  const currentPeriodStart = parsedNext
    ? addMonths(parsedNext, -1)
    : anchor;
  return computeIssueMonth(currentPeriodStart);
}

async function maybeIssueBonusFromUsageThreshold(
  tx: Tx,
  subscription: KiloPassSubscriptionState,
  kiloUserId: string
): Promise<void> {
  const monthlyBaseAmountUsd = KILO_PASS_TIER_CONFIG[subscription.tier].monthlyPriceUsd;

  // Determine the issuance to attach the bonus to
  let issuanceId: string | null;
  let issueMonth: string;

  if (subscription.cadence === KiloPassCadence.Monthly) {
    // Monthly: use the latest issuance for this subscription
    const latest = await tx
      .select({
        id: kilo_pass_issuances.id,
        issueMonth: kilo_pass_issuances.issue_month,
      })
      .from(kilo_pass_issuances)
      .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription.subscriptionId))
      .orderBy(desc(kilo_pass_issuances.issue_month))
      .limit(1);

    if (!latest[0]) {
      await clearKiloPassThreshold(tx, kiloUserId);
      return;
    }
    issuanceId = latest[0].id;
    issueMonth = latest[0].issueMonth;
  } else {
    // Yearly: get or create an issuance for the current period
    const ym = computeYearlyIssueMonth(subscription.nextYearlyIssueAt, subscription.startedAt);
    if (!ym) {
      await clearKiloPassThreshold(tx, kiloUserId);
      return;
    }
    issueMonth = ym;
    issuanceId = await createOrGetIssuanceHeader(tx, subscription.subscriptionId, issueMonth);
    if (!issuanceId) {
      await clearKiloPassThreshold(tx, kiloUserId);
      return;
    }
  }

  // Check that the base item exists (issuance must be funded before bonus can be issued)
  const baseItem = await tx
    .select({ id: kilo_pass_issuance_items.id })
    .from(kilo_pass_issuance_items)
    .where(
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
      )
    )
    .limit(1);

  if (!baseItem[0]) {
    await clearKiloPassThreshold(tx, kiloUserId);
    return;
  }

  // Idempotency: skip if bonus or promo item already issued
  const alreadyIssued = await tx
    .select({ id: kilo_pass_issuance_items.id })
    .from(kilo_pass_issuance_items)
    .where(
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
        inArray(kilo_pass_issuance_items.kind, [
          KiloPassIssuanceItemKind.Bonus,
          KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
        ])
      )
    )
    .limit(1);

  if (alreadyIssued[0]) {
    await clearKiloPassThreshold(tx, kiloUserId);
    return;
  }

  // Compute bonus percent
  let bonusPercentApplied: number;
  let description: string;
  let auditPayload: Record<string, unknown>;

  if (subscription.cadence !== KiloPassCadence.Monthly) {
    bonusPercentApplied = KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT;
    description = `Kilo Pass yearly monthly bonus (${subscription.tier}, ${issueMonth})`;
    auditPayload = { bonusKind: 'yearly-monthly' };
  } else {
    // Check if first-time subscriber
    const otherSubs = await tx
      .select({ id: kilo_pass_subscriptions.id })
      .from(kilo_pass_subscriptions)
      .where(
        and(
          eq(kilo_pass_subscriptions.kilo_user_id, kiloUserId),
          ne(kilo_pass_subscriptions.id, subscription.subscriptionId)
        )
      )
      .limit(1);

    const isFirstTimeSubscriberEver = otherSubs.length === 0;
    const streakMonths = Math.max(1, subscription.currentStreakMonths);
    bonusPercentApplied = computeMonthlyCadenceBonusPercent({
      tier: subscription.tier,
      streakMonths,
      isFirstTimeSubscriberEver,
      subscriptionStartedAtIso: subscription.startedAt,
    });
    const isPromo = bonusPercentApplied === 0.5 && streakMonths <= 2;
    description = isPromo
      ? `Kilo Pass promo 50% bonus (${subscription.tier}, streak=${streakMonths})`
      : `Kilo Pass monthly bonus (${subscription.tier}, streak=${streakMonths})`;
    auditPayload = {
      bonusKind: isPromo ? 'promo-50pct' : 'monthly-ramp',
      streakMonths,
      issueMonth,
    };
  }

  // Compute credit amount
  const baseCents = roundUsdToCents(monthlyBaseAmountUsd);
  const bonusCents = Math.round(baseCents * bonusPercentApplied);
  const bonusUsd = centsToUsd(bonusCents);
  const bonusMicrodollars = toMicrodollars(bonusUsd);

  const expiryDate = await computeBonusExpiryDate(tx, issuanceId, subscription.subscriptionId);

  const creditTransactionId = await grantBonusCredit(tx, {
    kiloUserId,
    amountMicrodollars: bonusMicrodollars,
    description,
    expiryDate,
  });

  // Record issuance item
  await tx.insert(kilo_pass_issuance_items).values({
    kilo_pass_issuance_id: issuanceId,
    kind: KiloPassIssuanceItemKind.Bonus,
    credit_transaction_id: creditTransactionId,
    amount_usd: bonusUsd,
    bonus_percent_applied: bonusPercentApplied,
  });

  // Audit log
  await tx.insert(kilo_pass_audit_log).values({
    action: KiloPassAuditLogAction.BonusCreditsIssued,
    result: KiloPassAuditLogResult.Success,
    kilo_user_id: kiloUserId,
    kilo_pass_subscription_id: subscription.subscriptionId,
    related_credit_transaction_id: creditTransactionId,
    related_monthly_issuance_id: issuanceId,
    payload_json: {
      source: 'usage_threshold',
      kind: KiloPassIssuanceItemKind.Bonus,
      bonusPercentApplied,
      bonusAmountUsd: bonusUsd,
      creditCategory: 'kilo-pass-bonus',
      ...auditPayload,
    },
  });

  // Clear threshold so we don't trigger again until Stripe sets a new one
  await clearKiloPassThreshold(tx, kiloUserId);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function maybeIssueKiloPassBonusFromUsageThreshold(
  db: WorkerDb,
  kiloUserId: string,
  _nowIso: string
): Promise<void> {
  await db.transaction(async tx => {
    // Lock the user row to prevent concurrent issuance
    const userRows = await tx
      .select({
        microdollarsUsed: kilocode_users.microdollars_used,
        kiloPassThreshold: kilocode_users.kilo_pass_threshold,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, kiloUserId))
      .for('update')
      .limit(1);

    const user = userRows[0];
    if (!user) return;

    const effectiveThreshold = getEffectiveKiloPassThreshold(user.kiloPassThreshold ?? null);
    if (effectiveThreshold === null || user.microdollarsUsed < effectiveThreshold) return;

    const subscriptionState = await getKiloPassStateForUser(tx as unknown as Tx, kiloUserId);
    if (!subscriptionState || subscriptionState.status !== 'active') {
      await clearKiloPassThreshold(tx as unknown as Tx, kiloUserId);
      return;
    }

    await maybeIssueBonusFromUsageThreshold(tx as unknown as Tx, subscriptionState, kiloUserId);
  });
}
