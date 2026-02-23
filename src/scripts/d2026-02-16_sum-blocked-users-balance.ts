import { and, isNull, eq } from 'drizzle-orm';
import { closeAllDrizzleConnections, db } from '@/lib/drizzle';
import type { User } from '@/db/schema';
import { credit_transactions as creditTransactionsTable, kilocode_users } from '@/db/schema';
import { retroactivelyExpireCreditsForUser } from '@/lib/creditExpiration';

function formatUsd(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(2)}`;
}

async function fetchFreeNonExpiringTransactionIds(userId: string) {
  const rows = await db
    .select({ id: creditTransactionsTable.id })
    .from(creditTransactionsTable)
    .where(
      and(
        eq(creditTransactionsTable.kilo_user_id, userId),
        eq(creditTransactionsTable.is_free, true),
        isNull(creditTransactionsTable.expiry_date),
        isNull(creditTransactionsTable.organization_id)
      )
    );
  return rows.map(r => r.id);
}

async function processUser(user: User) {
  const now = new Date();
  const transactionIds = await fetchFreeNonExpiringTransactionIds(user.id);

  if (transactionIds.length === 0) {
    console.log(`  ${user.google_user_email} — no free non-expiring credits, skipping`);
    return { skipped: true };
  }

  const firstBalanceBefore = user.total_microdollars_acquired - user.microdollars_used;
  let currentUser = user;

  for (const txnId of transactionIds) {
    const result = await retroactivelyExpireCreditsForUser(currentUser, now, txnId);
    if (!result) continue;

    // Re-fetch user for next iteration since balance changed
    const freshUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    if (freshUser) currentUser = freshUser;
  }

  const lastBalanceAfter = user.total_microdollars_acquired - user.microdollars_used;

  console.log(
    `  ${user.google_user_email} — balance before: ${formatUsd(firstBalanceBefore)}, after: ${formatUsd(lastBalanceAfter)}, expired: ${formatUsd(firstBalanceBefore - lastBalanceAfter)}`
  );
  return {
    skipped: false,
    email: user.google_user_email,
    balanceBefore: firstBalanceBefore,
    balanceAfter: lastBalanceAfter,
  };
}

async function main() {
  const userIdToProcess = process.argv[2];
  if (!userIdToProcess) {
    console.error('Usage: tsx src/scripts/d2026-02-16_sum-blocked-users-balance.ts <user-id>');
    process.exit(1);
  }

  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userIdToProcess),
  });

  if (!user) {
    console.error(`User with ID ${userIdToProcess} not found`);
    process.exit(1);
  }

  console.log(`Processing user: ${user.google_user_email}`);
  await processUser(user);
}

main()
  .catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await closeAllDrizzleConnections();
  });
