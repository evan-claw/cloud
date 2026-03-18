/**
 * Adds expiry dates to free, non-expiring credit transactions so they expire
 * on 2026-04-15.
 *
 * For each user the script:
 *   1. Fetches all personal credit transactions (excluding org-scoped).
 *   2. Identifies free, positive credits that have no expiry_date.
 *   3. Simulates what would expire on 2026-04-15 using computeExpiration().
 *   4. Writes a JSONL log line with the user's current/projected balance and
 *      per-credit projected expired amounts.
 *   5. In --execute mode, sets expiry_date and expiration_baseline on the
 *      affected transactions and updates the user's next_credit_expiration_at.
 *
 * Usage:
 *   pnpm script src/scripts/d2026-03-18_expire-free-credits.ts
 *   pnpm script src/scripts/d2026-03-18_expire-free-credits.ts --execute
 *   pnpm script src/scripts/d2026-03-18_expire-free-credits.ts --batch-size=1000
 *   pnpm script src/scripts/d2026-03-18_expire-free-credits.ts --concurrency=20
 */

import '../lib/load-env';

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { and, eq, gt, isNull, sql, inArray } from 'drizzle-orm';
import { computeExpiration, type ExpiringTransaction } from '@/lib/creditExpiration';

// ── Constants ────────────────────────────────────────────────────────────────

const EXPIRY_DATE = '2026-04-15T00:00:00.000Z';
const EXPIRY_DATE_OBJ = new Date(EXPIRY_DATE);

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(): { execute: boolean; batchSize: number; concurrency: number } {
  const args = process.argv.slice(2);
  let execute = false;
  let batchSize = 10_000;
  let concurrency = 50;

  for (const arg of args) {
    if (arg === '--execute') {
      execute = true;
    } else if (arg.startsWith('--batch-size=')) {
      const value = parseInt(arg.split('=')[1], 10);
      if (isNaN(value) || value <= 0) {
        console.error(`Invalid --batch-size value: ${arg}`);
        process.exit(1);
      }
      batchSize = value;
    } else if (arg.startsWith('--concurrency=')) {
      const value = parseInt(arg.split('=')[1], 10);
      if (isNaN(value) || value <= 0) {
        console.error(`Invalid --concurrency value: ${arg}`);
        process.exit(1);
      }
      concurrency = value;
    }
  }

  return { execute, batchSize, concurrency };
}

// ── Process a single user ────────────────────────────────────────────────────

async function processUser(
  user: {
    id: string;
    microdollars_used: number;
    total_microdollars_acquired: number;
    next_credit_expiration_at: string | null;
  },
  execute: boolean,
  output: ReturnType<typeof createWriteStream>
): Promise<{ creditsAffected: number; projectedExpiration: number } | null> {
  // 1. Fetch all user credit transactions (excluding org-scoped)
  const allTransactions = await db
    .select()
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, user.id),
        isNull(credit_transactions.organization_id)
      )
    );

  // 2. Find affected: free, non-expiring, positive credits
  const affected = allTransactions.filter(
    t => t.is_free && t.expiry_date == null && t.amount_microdollars > 0
  );
  if (affected.length === 0) return null;

  // 3. Build already-processed set (expiration records that exist)
  const processedOriginalIds = new Set(
    allTransactions
      .filter(
        t =>
          t.original_transaction_id != null &&
          (t.credit_category === 'credits_expired' ||
            t.credit_category === 'orb_credit_expired' ||
            t.credit_category === 'orb_credit_voided')
      )
      .map(t => t.original_transaction_id)
  );

  // 4. Build simulation input: existing unprocessed expiring credits + modified affected credits
  const existingExpiring: ExpiringTransaction[] = allTransactions
    .filter(
      t =>
        t.expiry_date != null && t.amount_microdollars > 0 && !processedOriginalIds.has(t.id)
    )
    .map(t => ({
      id: t.id,
      amount_microdollars: t.amount_microdollars,
      expiration_baseline_microdollars_used: t.expiration_baseline_microdollars_used,
      expiry_date: t.expiry_date,
      description: t.description,
      is_free: t.is_free,
    }));

  const modifiedAffected: ExpiringTransaction[] = affected.map(t => ({
    id: t.id,
    amount_microdollars: t.amount_microdollars,
    expiration_baseline_microdollars_used: t.original_baseline_microdollars_used ?? 0,
    expiry_date: EXPIRY_DATE,
    description: t.description,
    is_free: t.is_free,
  }));

  const simulationInput = [...existingExpiring, ...modifiedAffected];

  // 5. Run simulation — use EXPIRY_DATE_OBJ as `now` to project what would happen on 2026-04-15
  const entity = { id: user.id, microdollars_used: user.microdollars_used };
  const { newTransactions } = computeExpiration(simulationInput, entity, EXPIRY_DATE_OBJ, user.id);

  // 6. Map projected expired amounts back to affected credits
  const expiredByOriginalId = new Map(
    newTransactions.map(t => [t.original_transaction_id, Math.abs(t.amount_microdollars ?? 0)])
  );

  const currentBalance = user.total_microdollars_acquired - user.microdollars_used;
  const totalExpiredAll = newTransactions.reduce(
    (sum, t) => sum + Math.abs(t.amount_microdollars ?? 0),
    0
  );
  const projectedBalance = currentBalance - totalExpiredAll;

  const creditsAffectedWithProjection = affected.map(t => ({
    ...t,
    projected_expired_amount_microdollars: expiredByOriginalId.get(t.id) ?? 0,
  }));

  // 7. Write JSONL line
  const logLine = JSON.stringify({
    user_id: user.id,
    current_balance_microdollars: currentBalance,
    projected_balance_microdollars: projectedBalance,
    credits_affected: creditsAffectedWithProjection,
  });
  output.write(logLine + '\n');

  // 8. Execute mode: write DB changes
  if (execute) {
    const affectedIds = affected.map(t => t.id);
    await db.transaction(async tx => {
      await tx
        .update(credit_transactions)
        .set({
          expiry_date: EXPIRY_DATE,
          expiration_baseline_microdollars_used: sql`COALESCE(${credit_transactions.original_baseline_microdollars_used}, 0)`,
        })
        .where(inArray(credit_transactions.id, affectedIds));

      // COALESCE needed because LEAST(NULL, x) returns NULL in PostgreSQL
      await tx
        .update(kilocode_users)
        .set({
          next_credit_expiration_at: sql`COALESCE(LEAST(${kilocode_users.next_credit_expiration_at}, ${EXPIRY_DATE}), ${EXPIRY_DATE})`,
        })
        .where(eq(kilocode_users.id, user.id));
    });
  }

  // 9. Return total projected expiration only for the newly-tagged credits
  const projectedExpirationForAffected = affected.reduce(
    (sum, t) => sum + (expiredByOriginalId.get(t.id) ?? 0),
    0
  );

  return { creditsAffected: affected.length, projectedExpiration: projectedExpirationForAffected };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { execute, batchSize, concurrency } = parseArgs();

  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Concurrency: ${concurrency}\n`);

  const outputDir = path.join(__dirname, 'output');
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const output = createWriteStream(
    path.join(outputDir, `expire-free-credits-${timestamp}.jsonl`)
  );
  const errorLog = createWriteStream(
    path.join(outputDir, `expire-free-credits-${timestamp}.errors.jsonl`)
  );
  console.log(`Output:  ${path.join(outputDir, `expire-free-credits-${timestamp}.jsonl`)}`);
  console.log(`Errors:  ${path.join(outputDir, `expire-free-credits-${timestamp}.errors.jsonl`)}\n`);

  const limit = pLimit(concurrency);

  let lastId = '';
  let totalUsers = 0;
  let totalCreditsAffected = 0;
  let totalProjectedExpiration = 0;
  let usersAffected = 0;
  let totalErrors = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await db
      .select({
        id: kilocode_users.id,
        microdollars_used: kilocode_users.microdollars_used,
        total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
        next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      })
      .from(kilocode_users)
      .where(gt(kilocode_users.id, lastId))
      .orderBy(kilocode_users.id)
      .limit(batchSize);

    if (batch.length === 0) break;

    const results = await Promise.allSettled(
      batch.map((user, i) =>
        limit(async () => {
          const result = await processUser(user, execute, output);
          return { index: i, result };
        })
      )
    );

    for (let i = 0; i < results.length; i++) {
      const settled = results[i];
      totalUsers++;
      if (settled.status === 'rejected') {
        totalErrors++;
        const error = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        errorLog.write(JSON.stringify({ user_id: batch[i].id, error }) + '\n');
      } else if (settled.value.result) {
        usersAffected++;
        totalCreditsAffected += settled.value.result.creditsAffected;
        totalProjectedExpiration += settled.value.result.projectedExpiration;
      }
    }

    lastId = batch[batch.length - 1].id;
    console.log(
      `Processed ${totalUsers} users so far (${usersAffected} affected, ${totalCreditsAffected} credits tagged, ${totalErrors} errors)...`
    );
  }

  output.end();
  errorLog.end();

  console.log('\n--- Summary ---');
  console.log(`Total users scanned:        ${totalUsers}`);
  console.log(`Users with affected credits: ${usersAffected}`);
  console.log(`Total credits tagged:        ${totalCreditsAffected}`);
  console.log(
    `Projected expiration total:  ${totalProjectedExpiration} microdollars ($${(totalProjectedExpiration / 1_000_000).toFixed(2)})`
  );
  console.log(`Errors:                      ${totalErrors}`);
  console.log(`Mode:                        ${execute ? 'EXECUTED' : 'DRY RUN'}`);
}

void main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => closeAllDrizzleConnections());
