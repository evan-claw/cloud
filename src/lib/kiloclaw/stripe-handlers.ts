import 'server-only';

import type Stripe from 'stripe';
import { eq, and, isNull, inArray, sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_email_log,
} from '@kilocode/db/schema';
import type { KiloClawSubscriptionStatus } from '@kilocode/db/schema-types';
import {
  getClawPlanForStripePriceId,
  getStripePriceIdForClawPlan,
} from '@/lib/kiloclaw/stripe-price-ids.server';
import { sentryLogger } from '@/lib/utils.server';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { client as stripe } from '@/lib/stripe-client';

const logInfo = sentryLogger('kiloclaw-stripe', 'info');
const logWarning = sentryLogger('kiloclaw-stripe', 'warning');
const logError = sentryLogger('kiloclaw-stripe', 'error');

type KiloClawSubscriptionMetadata = {
  type: 'kiloclaw';
  plan: 'commit' | 'standard';
  kiloUserId: string;
};

function getKiloClawMetadata(
  metadata: Stripe.Metadata | null | undefined
): KiloClawSubscriptionMetadata | null {
  if (!metadata || metadata.type !== 'kiloclaw') return null;
  const plan = metadata.plan;
  const kiloUserId = metadata.kiloUserId;
  if (!plan || !kiloUserId) return null;
  if (plan !== 'commit' && plan !== 'standard') return null;
  return { type: 'kiloclaw', plan, kiloUserId };
}

function getSubscriptionPeriods(subscription: Stripe.Subscription) {
  // In the current Stripe API, period timestamps live on the subscription item, not the subscription.
  const item = subscription.items.data[0];
  return {
    current_period_start: item ? new Date(item.current_period_start * 1000).toISOString() : null,
    current_period_end: item ? new Date(item.current_period_end * 1000).toISOString() : null,
  };
}

/**
 * Detect the plan from a Stripe subscription's price ID.
 * Falls back to metadata if price lookup fails.
 */
function detectPlanFromSubscription(
  subscription: Stripe.Subscription,
  metadataPlan: 'commit' | 'standard'
): 'commit' | 'standard' {
  const priceId = subscription.items?.data[0]?.price?.id;
  const planFromPrice = priceId ? getClawPlanForStripePriceId(priceId) : null;
  return planFromPrice ?? metadataPlan;
}

const STRIPE_TO_CLAW_STATUS: Record<string, KiloClawSubscriptionStatus> = {
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'unpaid',
  incomplete: 'unpaid',
  incomplete_expired: 'canceled',
  paused: 'canceled',
};

/**
 * Map a Stripe subscription status to our internal status.
 * Only called for paid plans (commit/standard). Subscriptions created with
 * trial_end (delayed billing) arrive as 'trialing' — treat as active.
 */
function mapStripeStatus(stripeStatus: string): KiloClawSubscriptionStatus {
  if (stripeStatus === 'trialing') return 'active';
  return STRIPE_TO_CLAW_STATUS[stripeStatus] ?? 'active';
}

/**
 * If the user was suspended, try to start their instance and clear suspension state.
 */
async function autoResumeIfSuspended(kiloUserId: string): Promise<void> {
  const [activeInstance] = await db
    .select({ id: kiloclaw_instances.id })
    .from(kiloclaw_instances)
    .where(and(eq(kiloclaw_instances.user_id, kiloUserId), isNull(kiloclaw_instances.destroyed_at)))
    .limit(1);

  if (activeInstance) {
    try {
      const client = new KiloClawInternalClient();
      await client.start(kiloUserId);
    } catch (startError) {
      logError('Failed to auto-resume instance', {
        user_id: kiloUserId,
        error: startError instanceof Error ? startError.message : String(startError),
      });
    }
  }

  // Clear suspension/destruction cycle emails so they can fire again in a future cycle.
  // Trial and earlybird warnings are one-time events and must NOT be cleared.
  const resettableEmailTypes = [
    'claw_suspended_trial',
    'claw_suspended_subscription',
    'claw_suspended_payment',
    'claw_destruction_warning',
    'claw_instance_destroyed',
  ];
  await db
    .delete(kiloclaw_email_log)
    .where(
      and(
        eq(kiloclaw_email_log.user_id, kiloUserId),
        inArray(kiloclaw_email_log.email_type, resettableEmailTypes)
      )
    );

  await db
    .update(kiloclaw_subscriptions)
    .set({ suspended_at: null, destruction_deadline: null })
    .where(eq(kiloclaw_subscriptions.user_id, kiloUserId));
}

/**
 * Handle customer.subscription.created for KiloClaw subscriptions.
 *
 * Stripe propagates subscription_data.metadata from the checkout session
 * to the subscription object, so we can read kiloUserId and plan from metadata.
 */
export async function handleKiloClawSubscriptionCreated(params: {
  eventId: string;
  subscription: Stripe.Subscription;
}): Promise<void> {
  const { eventId, subscription } = params;
  const metadata = getKiloClawMetadata(subscription.metadata);

  if (!metadata) {
    logWarning('KiloClaw subscription.created missing metadata', {
      stripe_event_id: eventId,
      stripe_subscription_id: subscription.id,
    });
    return;
  }

  const { kiloUserId } = metadata;
  const plan = detectPlanFromSubscription(subscription, metadata.plan);
  const periods = getSubscriptionPeriods(subscription);
  const status = mapStripeStatus(subscription.status);

  await db.transaction(async tx => {
    // Guard against stale subscription.created retries: if the user already has
    // a row referencing a different Stripe subscription, this event is outdated
    // and must not overwrite the newer subscription's data.
    // Exception: if the existing row is canceled, this is a legitimate
    // re-subscription (createSubscriptionCheckout allows canceled users to
    // buy again), so we let the upsert proceed.
    const [existingRow] = await tx
      .select({
        stripe_subscription_id: kiloclaw_subscriptions.stripe_subscription_id,
        status: kiloclaw_subscriptions.status,
      })
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, kiloUserId))
      .limit(1);

    if (
      existingRow &&
      existingRow.stripe_subscription_id !== null &&
      existingRow.stripe_subscription_id !== subscription.id &&
      existingRow.status !== 'canceled'
    ) {
      logWarning(
        'Ignoring stale subscription.created — user already has a different subscription',
        {
          stripe_event_id: eventId,
          stale_subscription_id: subscription.id,
          current_subscription_id: existingRow.stripe_subscription_id,
        }
      );
      return;
    }

    // Upsert: if trial row exists, upgrade it; otherwise insert new row.
    // For commit plans, commit_ends_at is computed after schedule creation
    // (current_period_end may only be the delayed-billing trial boundary).
    await tx
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: kiloUserId,
        stripe_subscription_id: subscription.id,
        plan,
        status,
        cancel_at_period_end: subscription.cancel_at_period_end,
        current_period_start: periods.current_period_start,
        current_period_end: periods.current_period_end,
        commit_ends_at: plan === 'commit' ? periods.current_period_end : null,
      })
      .onConflictDoUpdate({
        target: kiloclaw_subscriptions.user_id,
        set: {
          stripe_subscription_id: subscription.id,
          plan,
          status,
          cancel_at_period_end: subscription.cancel_at_period_end,
          current_period_start: periods.current_period_start,
          current_period_end: periods.current_period_end,
          // Preserve existing commit_ends_at on conflict (e.g. webhook replay after
          // the schedule already set the real six-month boundary). The schedule
          // creation below will overwrite this with the authoritative value.
          commit_ends_at:
            plan === 'commit'
              ? sql`COALESCE(${kiloclaw_subscriptions.commit_ends_at}, ${periods.current_period_end})`
              : null,
          // Reset delinquency/suspension state from a previous subscription so
          // the new subscription gets a full 14-day grace period on first failure.
          past_due_since: null,
          suspended_at: null,
          destruction_deadline: null,
        },
      });

    // For commit plan: create schedule for auto-transition to standard after commit period.
    // Guard against webhook replay: skip if a schedule already exists for this subscription.
    if (plan === 'commit') {
      const [existingRow] = await tx
        .select({ stripe_schedule_id: kiloclaw_subscriptions.stripe_schedule_id })
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.user_id, kiloUserId))
        .limit(1);

      if (existingRow?.stripe_schedule_id) {
        logInfo('Skipping schedule creation — schedule already exists (likely webhook replay)', {
          stripe_event_id: eventId,
          stripe_subscription_id: subscription.id,
          existing_schedule_id: existingRow.stripe_schedule_id,
        });
      } else {
        try {
          const commitPriceId = getStripePriceIdForClawPlan('commit');
          const standardPriceId = getStripePriceIdForClawPlan('standard');

          const schedule = await stripe.subscriptionSchedules.create({
            from_subscription: subscription.id,
          });

          // Preserve the initial phase from from_subscription (which may include a
          // delayed-billing trial_end period) so prelaunch trial days are not
          // deducted from the 6-month commit term.
          // Use Stripe's duration API for the commit phase to get exact calendar
          // months (matching switchPlan and renewCommit) instead of a 180-day
          // approximation.
          const currentPhase = schedule.phases[0];

          const updatedSchedule = await stripe.subscriptionSchedules.update(schedule.id, {
            end_behavior: 'release',
            phases: [
              ...(currentPhase
                ? [
                    {
                      items: [{ price: commitPriceId }],
                      start_date: currentPhase.start_date,
                      end_date: currentPhase.end_date,
                    },
                  ]
                : []),
              {
                items: [{ price: commitPriceId }],
                duration: { interval: 'month' as const, interval_count: 6 },
              },
              { items: [{ price: standardPriceId }] },
            ],
          });

          // Derive commit_ends_at from the schedule's resolved phases.
          // The commit phase is the second-to-last phase (before the standard phase).
          // This is the authoritative end date, not current_period_end which may
          // only reflect the delayed-billing trial boundary.
          const commitPhase = updatedSchedule.phases[updatedSchedule.phases.length - 2];
          const commitEndsAt = commitPhase
            ? new Date(commitPhase.end_date * 1000).toISOString()
            : periods.current_period_end;

          await tx
            .update(kiloclaw_subscriptions)
            .set({
              stripe_schedule_id: schedule.id,
              scheduled_plan: 'standard',
              scheduled_by: 'auto',
              commit_ends_at: commitEndsAt,
            })
            .where(eq(kiloclaw_subscriptions.user_id, kiloUserId));
        } catch (scheduleError) {
          logError('Failed to create commit-to-standard schedule', {
            stripe_event_id: eventId,
            stripe_subscription_id: subscription.id,
            error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError),
          });
          // Re-throw so the transaction rolls back and the webhook returns a 5xx,
          // prompting Stripe to retry once the transient error resolves.
          throw scheduleError;
        }
      }
    }
  });

  // Auto-resume: if user was suspended, start their instance and clear suspension
  const [subRow] = await db
    .select({ suspended_at: kiloclaw_subscriptions.suspended_at })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.user_id, kiloUserId))
    .limit(1);

  if (subRow?.suspended_at) {
    await autoResumeIfSuspended(kiloUserId);
  }

  logInfo('KiloClaw subscription.created processed', {
    stripe_event_id: eventId,
    user_id: kiloUserId,
    plan,
  });
}

/**
 * Handle customer.subscription.updated for KiloClaw subscriptions.
 */
export async function handleKiloClawSubscriptionUpdated(params: {
  eventId: string;
  subscription: Stripe.Subscription;
}): Promise<void> {
  const { eventId, subscription } = params;
  const metadata = getKiloClawMetadata(subscription.metadata);

  if (!metadata) {
    logWarning('KiloClaw subscription.updated missing metadata', {
      stripe_event_id: eventId,
      stripe_subscription_id: subscription.id,
    });
    return;
  }

  const { kiloUserId } = metadata;
  const plan = detectPlanFromSubscription(subscription, metadata.plan);
  const periods = getSubscriptionPeriods(subscription);
  const status = mapStripeStatus(subscription.status);

  const wasSuspended =
    status === 'active'
      ? await db
          .select({ suspended_at: kiloclaw_subscriptions.suspended_at })
          .from(kiloclaw_subscriptions)
          .where(
            and(
              eq(kiloclaw_subscriptions.user_id, kiloUserId),
              eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id)
            )
          )
          .limit(1)
          .then(([row]) => !!row?.suspended_at)
      : false;

  // Guard on stripe_subscription_id so stale webhooks for a superseded
  // subscription don't overwrite the replacement subscription's data.
  await db
    .update(kiloclaw_subscriptions)
    .set({
      status,
      plan,
      cancel_at_period_end: subscription.cancel_at_period_end,
      current_period_start: periods.current_period_start,
      current_period_end: periods.current_period_end,
      // For commit plans, preserve an existing commit_ends_at (set during subscription
      // creation, switchPlan, or renewal). If null — e.g. a plan-switch webhook arrived
      // before the schedule update persisted the boundary — fall back to current_period_end
      // so downstream code (reactivateSubscription, renewCommit, UI) always has a value.
      // When leaving commit, clear it.
      ...(plan !== 'commit'
        ? { commit_ends_at: null }
        : {
            commit_ends_at: sql`COALESCE(${kiloclaw_subscriptions.commit_ends_at}, ${periods.current_period_end})`,
          }),
      // Record when the subscription first entered past_due; clear when recovered.
      // past_due_since drives the 14-day grace period in the billing lifecycle cron
      // (updated_at would be unreliable because $onUpdateFn refreshes it on every write).
      past_due_since:
        status === 'past_due'
          ? sql`COALESCE(${kiloclaw_subscriptions.past_due_since}, now())`
          : null,
      ...(status === 'active' ? { suspended_at: null, destruction_deadline: null } : {}),
    })
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, kiloUserId),
        eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id)
      )
    );

  if (wasSuspended) {
    await autoResumeIfSuspended(kiloUserId);
  }

  logInfo('KiloClaw subscription.updated processed', {
    stripe_event_id: eventId,
    user_id: kiloUserId,
    status,
    plan,
  });
}

/**
 * Handle customer.subscription.deleted for KiloClaw subscriptions.
 * Sets status to canceled. The billing lifecycle cron handles graceful shutdown.
 */
export async function handleKiloClawSubscriptionDeleted(params: {
  eventId: string;
  subscription: Stripe.Subscription;
}): Promise<void> {
  const { eventId, subscription } = params;
  const metadata = getKiloClawMetadata(subscription.metadata);

  if (!metadata) {
    logWarning('KiloClaw subscription.deleted missing metadata', {
      stripe_event_id: eventId,
      stripe_subscription_id: subscription.id,
    });
    return;
  }

  const { kiloUserId } = metadata;

  // Guard on stripe_subscription_id so a stale delete webhook for a
  // superseded subscription doesn't cancel the replacement subscription.
  await db
    .update(kiloclaw_subscriptions)
    .set({
      status: 'canceled',
      cancel_at_period_end: false,
      scheduled_plan: null,
      scheduled_by: null,
      stripe_schedule_id: null,
    })
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, kiloUserId),
        eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id)
      )
    );

  logInfo('KiloClaw subscription.deleted processed', {
    stripe_event_id: eventId,
    user_id: kiloUserId,
  });
}

/**
 * Handle subscription_schedule.updated for KiloClaw subscriptions.
 * When a schedule completes (commit -> standard transition):
 * - Update plan to 'standard'
 * - Clear schedule tracking fields
 */
export async function handleKiloClawScheduleEvent(params: {
  eventId: string;
  schedule: Stripe.SubscriptionSchedule;
}): Promise<void> {
  const { eventId, schedule } = params;
  const scheduleId = schedule.id;
  const scheduleStatus = schedule.status;

  // Find the row that references this schedule
  const [row] = await db
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      plan: kiloclaw_subscriptions.plan,
      scheduled_plan: kiloclaw_subscriptions.scheduled_plan,
    })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.stripe_schedule_id, scheduleId))
    .limit(1);

  if (!row) {
    // Not a KiloClaw schedule — return silently so the kilo-pass handler can try
    return;
  }

  if (
    scheduleStatus === 'released' ||
    scheduleStatus === 'canceled' ||
    scheduleStatus === 'completed'
  ) {
    const updateSet: Partial<typeof kiloclaw_subscriptions.$inferInsert> = {
      stripe_schedule_id: null,
      scheduled_plan: null,
      scheduled_by: null,
    };

    // Only apply the scheduled plan on 'completed' — 'released' fires when
    // cancelSubscription or cancelPlanSwitch intentionally releases the schedule,
    // which should NOT change the current plan.
    if (scheduleStatus === 'completed' && row.scheduled_plan) {
      updateSet.plan = row.scheduled_plan;
      if (row.scheduled_plan === 'standard') {
        updateSet.commit_ends_at = null;
      }
    }

    await db
      .update(kiloclaw_subscriptions)
      .set(updateSet)
      .where(eq(kiloclaw_subscriptions.stripe_schedule_id, scheduleId));
  }

  logInfo('KiloClaw schedule event processed', {
    stripe_event_id: eventId,
    schedule_id: scheduleId,
    schedule_status: scheduleStatus,
    user_id: row.user_id,
  });
}

/**
 * Handle invoice.paid for KiloClaw subscriptions.
 * Used for commit renewal invoices — updates commit_ends_at.
 */
export async function handleKiloClawInvoicePaid(params: {
  eventId: string;
  invoice: Stripe.Invoice;
}): Promise<void> {
  const { eventId, invoice } = params;

  // Get the subscription from the invoice's parent
  const subscriptionUnion = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = subscriptionUnion
    ? typeof subscriptionUnion === 'string'
      ? subscriptionUnion
      : subscriptionUnion.id
    : null;

  if (!subscriptionId) return;

  // Find the kiloclaw subscription row
  const [row] = await db
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      plan: kiloclaw_subscriptions.plan,
      commit_ends_at: kiloclaw_subscriptions.commit_ends_at,
    })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.stripe_subscription_id, subscriptionId))
    .limit(1);

  if (!row) return;

  // The renewCommit mutation already extends commit_ends_at directly.
  // This handler only logs the event for auditing.

  logInfo('KiloClaw invoice.paid processed', {
    stripe_event_id: eventId,
    invoice_id: invoice.id,
    user_id: row.user_id,
    plan: row.plan,
  });
}
