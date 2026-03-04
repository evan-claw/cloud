// Balance and organization checks.
// Skipped for anonymous users (they can only use free models, already rate-limited above).
// Skipped for custom LLM requests when the org matches.
//
// Checks (in order):
//   1. User/org balance > 0 for paid model requests
//   2. Org model/provider allow list restrictions
//   3. Data collection requirement for Kilo free models

import type { MiddlewareHandler } from 'hono';
import type { HonoContext } from '../types/hono';
import { isAnonymousContext } from '../lib/anonymous';
import { isFreeModel, isDataCollectionRequiredOnKiloCodeOnly } from '../lib/models';
import {
  getBalanceAndOrgSettings,
  checkOrganizationModelRestrictions,
} from '../lib/org-restrictions';
import { isActiveReviewPromo, isActiveCloudAgentPromo } from '../lib/promotions';
import { maybePerformOrganizationAutoTopUp } from '../lib/auto-top-up';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { and, eq, gt, notExists, sql } from 'drizzle-orm';
import { credit_transactions, kilo_pass_issuance_items } from '@kilocode/db/schema';

// Mirrors summarizeUserPayments() in src/lib/creditTransactions.ts.
// Returns true if the user has made at least one paid (non-free) top-up,
// excluding KiloPass bonus credits (which are linked via kilo_pass_issuance_items).
async function hasUserMadePaidTopup(db: WorkerDb, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, userId),
        eq(credit_transactions.is_free, false),
        gt(credit_transactions.amount_microdollars, 0),
        notExists(
          db
            .select({ id: kilo_pass_issuance_items.id })
            .from(kilo_pass_issuance_items)
            .where(eq(kilo_pass_issuance_items.credit_transaction_id, credit_transactions.id))
        )
      )
    );
  return (row?.count ?? 0) > 0;
}

function isFreePromptTrainingAllowed(
  provider: { data_collection?: 'allow' | 'deny' } | undefined
): boolean {
  return provider?.data_collection !== 'deny';
}

export const balanceAndOrgCheckMiddleware: MiddlewareHandler<HonoContext> = async (c, next) => {
  const user = c.get('user');
  const resolvedModel = c.get('resolvedModel');
  const organizationId = c.get('organizationId');
  const customLlm = c.get('customLlm');
  const userByok = c.get('userByok');
  const botId = c.get('botId');
  const tokenSource = c.get('tokenSource');
  const requestBody = c.get('requestBody');

  // Anonymous users only access free models, already rate-limited in earlier middleware
  if (isAnonymousContext(user)) {
    await next();
    return;
  }

  // Custom LLM when the org has explicitly configured it — bypass access checks
  const bypassForCustomLlm =
    !!customLlm && !!organizationId && customLlm.organization_ids.includes(organizationId);
  if (bypassForCustomLlm) {
    await next();
    return;
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const { balance, settings, plan, autoTopUp } = await getBalanceAndOrgSettings(
    db,
    organizationId,
    user
  );

  // Trigger org auto-top-up in the background (matches reference after() pattern)
  if (autoTopUp) {
    c.executionCtx.waitUntil(
      maybePerformOrganizationAutoTopUp(db, {
        id: autoTopUp.organizationId,
        auto_top_up_enabled: autoTopUp.auto_top_up_enabled,
        total_microdollars_acquired: autoTopUp.total_microdollars_acquired,
        microdollars_used: autoTopUp.microdollars_used,
      }).catch(err => {
        console.error('[balance-and-org] auto-top-up failed', err);
      })
    );
  }

  // Balance check for paid models
  if (
    balance <= 0 &&
    !isFreeModel(resolvedModel) &&
    !userByok &&
    !isActiveReviewPromo(botId, resolvedModel) &&
    !isActiveCloudAgentPromo(tokenSource, resolvedModel)
  ) {
    // Mirror usageLimitExceededResponse(): branch on payment history to choose title/message.
    const isReturningUser = await hasUserMadePaidTopup(db, user.id);
    const title = isReturningUser ? 'Low Credit Warning!' : 'Paid Model - Credits Required';
    // The reference calls FIRST_TOPUP_BONUS_AMOUNT() which returns 20 (the XL promo
    // deadline of 2025-10-14 has passed). If that constant ever changes, update here.
    const FIRST_TOPUP_BONUS = 20;
    const message = isReturningUser
      ? 'Add credits to continue, or switch to a free model'
      : `This is a paid model. To use paid models, you need to add credits. Get $${FIRST_TOPUP_BONUS} free on your first topup!`;
    return c.json(
      { error: { title, message, balance, buyCreditsUrl: 'https://app.kilo.ai/profile' } },
      402
    );
  }

  // Organization model and provider restrictions
  const { error: restrictionError, providerConfig } = checkOrganizationModelRestrictions({
    modelId: resolvedModel,
    settings,
    organizationPlan: plan,
  });

  if (restrictionError) {
    // The reference modelNotAllowedResponse() uses distinct error/message values.
    return c.json(
      {
        error: restrictionError.message,
        message: 'The requested model is not allowed for your team.',
      },
      restrictionError.status
    );
  }

  // Apply provider config from org restrictions to the request body before data-collection check
  if (providerConfig) {
    requestBody.provider = providerConfig;
  }

  // Data collection check — Kilo free models require prompt training unless org explicitly denies
  if (
    isDataCollectionRequiredOnKiloCodeOnly(resolvedModel) &&
    !isFreePromptTrainingAllowed(requestBody.provider)
  ) {
    const error =
      'Data collection is required for this model. Please enable data collection to use this model or choose another model.';
    return c.json({ error, message: error }, 400);
  }

  await next();
};
