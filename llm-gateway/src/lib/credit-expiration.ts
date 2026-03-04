// Organization credit expiry — port of src/lib/creditExpiration.ts
// (processOrganizationExpirations, fetchExpiringTransactionsForOrganization, computeExpiration)

import type { WorkerDb } from '@kilocode/db/client';
import type { CreditTransaction, credit_transactions } from '@kilocode/db/schema';
import {
  credit_transactions as creditTransactionsTable,
  organizations,
} from '@kilocode/db/schema';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

type ExpiringTransaction = Pick<
  CreditTransaction,
  | 'id'
  | 'amount_microdollars'
  | 'expiration_baseline_microdollars_used'
  | 'expiry_date'
  | 'description'
  | 'is_free'
>;

type ExpirationResult = {
  newTransactions: (typeof credit_transactions.$inferInsert)[];
  newBaselines: Map<CreditTransaction['id'], number>;
};

type EntityForExpiration = { id: string; microdollars_used: number };

export function computeExpiration(
  transactions: ExpiringTransaction[],
  entity: EntityForExpiration,
  now: Date,
  kilo_user_id: string
): ExpirationResult {
  const newBaselines = new Map<CreditTransaction['id'], number>();
  const newTransactions: (typeof credit_transactions.$inferInsert)[] = [];
  const sortedByExpiry = transactions
    .filter((t): t is ExpiringTransaction & { expiry_date: string } => t.expiry_date != null)
    .sort((a, b) => new Date(a.expiry_date).getTime() - new Date(b.expiry_date).getTime());

  for (let currentIndex = 0; currentIndex < sortedByExpiry.length; currentIndex++) {
    const t = sortedByExpiry[currentIndex];
    const isExpired = new Date(t.expiry_date) <= now;
    if (!isExpired) continue;

    const baseline = newBaselines.get(t.id) ?? t.expiration_baseline_microdollars_used ?? 0;
    const transactionEnd = baseline + t.amount_microdollars;
    const usageEnd = Math.min(transactionEnd, entity.microdollars_used);
    const usage = Math.max(0, usageEnd - baseline);
    const expiredAmount = t.amount_microdollars - usage;
    newTransactions.push({
      kilo_user_id,
      amount_microdollars: expiredAmount === 0 ? 0 : -expiredAmount,
      credit_category: 'credits_expired',
      original_transaction_id: t.id,
      description: `Expired: ${t.description ?? ''}`,
      is_free: t.is_free,
      created_at: t.expiry_date,
      original_baseline_microdollars_used: entity.microdollars_used,
    });
    for (let laterIndex = currentIndex + 1; laterIndex < sortedByExpiry.length; laterIndex++) {
      const otherT = sortedByExpiry[laterIndex];
      const otherBaseline =
        newBaselines.get(otherT.id) ?? otherT.expiration_baseline_microdollars_used ?? 0;
      const consumedOverlap = Math.min(usage, usageEnd - otherBaseline);
      if (consumedOverlap <= 0) continue;
      newBaselines.set(otherT.id, otherBaseline + consumedOverlap);
    }
  }
  return { newTransactions, newBaselines };
}

async function fetchExpiringTransactionsForOrganization(
  db: WorkerDb,
  organizationId: string
): Promise<ExpiringTransaction[]> {
  const expiredCredits = alias(creditTransactionsTable, 'expired_credits');

  return await db
    .select({
      id: creditTransactionsTable.id,
      amount_microdollars: creditTransactionsTable.amount_microdollars,
      expiration_baseline_microdollars_used:
        creditTransactionsTable.expiration_baseline_microdollars_used,
      expiry_date: creditTransactionsTable.expiry_date,
      description: creditTransactionsTable.description,
      is_free: creditTransactionsTable.is_free,
    })
    .from(creditTransactionsTable)
    .leftJoin(
      expiredCredits,
      and(
        eq(expiredCredits.organization_id, organizationId),
        eq(expiredCredits.credit_category, 'credits_expired'),
        eq(expiredCredits.original_transaction_id, creditTransactionsTable.id)
      )
    )
    .where(
      and(
        eq(creditTransactionsTable.organization_id, organizationId),
        isNotNull(creditTransactionsTable.expiry_date),
        isNull(expiredCredits.id)
      )
    );
}

type OrganizationForExpiration = {
  id: string;
  microdollars_used: number;
  next_credit_expiration_at: string | null;
  total_microdollars_acquired: number;
};

export async function processOrganizationExpirations(
  db: WorkerDb,
  org: OrganizationForExpiration,
  now: Date
): Promise<null | { total_microdollars_acquired: number }> {
  const next_credit_expiration_at = org.next_credit_expiration_at;
  const all_expiring_transactions = await fetchExpiringTransactionsForOrganization(db, org.id);

  const expirationResult = computeExpiration(all_expiring_transactions, org, now, 'system');

  const expiredTransactionIds = new Set(
    expirationResult.newTransactions.map(t => t.original_transaction_id)
  );
  const new_next_expiration =
    all_expiring_transactions
      .filter(t => !expiredTransactionIds.has(t.id))
      .map(t => t.expiry_date)
      .filter(Boolean)
      .sort()[0] ?? null;

  const total_expired = expirationResult.newTransactions.reduce(
    (sum, t) => sum + (t.amount_microdollars ?? 0),
    0
  );
  const new_total_microdollars_acquired = org.total_microdollars_acquired + total_expired;

  const somethingExpired = await db.transaction(async tx => {
    const updateResult = await tx
      .update(organizations)
      .set({
        next_credit_expiration_at: new_next_expiration,
        total_microdollars_acquired: new_total_microdollars_acquired,
        microdollars_balance: sql`${organizations.microdollars_balance} + ${total_expired}`,
      })
      .where(
        and(
          eq(organizations.id, org.id),
          eq(organizations.total_microdollars_acquired, org.total_microdollars_acquired),
          next_credit_expiration_at
            ? eq(organizations.next_credit_expiration_at, next_credit_expiration_at)
            : isNull(organizations.next_credit_expiration_at)
        )
      );

    if (updateResult.rowCount === 0) {
      console.error('processOrganizationExpirations: optimistic concurrency check failed', {
        organization_id: org.id,
      });
      return false;
    }

    if (!expirationResult.newTransactions.length && !expirationResult.newBaselines.size)
      return false;

    const transactionsWithOrgId = expirationResult.newTransactions.map(t => ({
      ...t,
      organization_id: org.id,
    }));
    await tx.insert(creditTransactionsTable).values(transactionsWithOrgId);

    for (const [transactionId, newBaseline] of expirationResult.newBaselines) {
      await tx
        .update(creditTransactionsTable)
        .set({ expiration_baseline_microdollars_used: newBaseline })
        .where(eq(creditTransactionsTable.id, transactionId));
    }
    return true;
  });

  if (!somethingExpired) return null;
  return { total_microdollars_acquired: new_total_microdollars_acquired };
}
