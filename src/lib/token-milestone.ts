import { db } from '@/lib/drizzle';
import { kilocode_users, microdollar_usage } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { TOKEN_MILESTONE_WEBHOOK_URL, TOKEN_MILESTONE_THRESHOLD } from '@/lib/config.server';

/**
 * Checks whether the user has crossed the cumulative token milestone and,
 * if so, atomically marks the milestone and fires a webhook.
 *
 * Designed to be called fire-and-forget after each usage insert so it
 * never blocks the main request path.
 */
export async function maybeFireTokenMilestoneWebhook(kiloUserId: string): Promise<void> {
  if (!TOKEN_MILESTONE_WEBHOOK_URL) return;

  // 1. Sum cumulative tokens (input + output) across all usage rows for this user.
  const [totals] = await db
    .select({
      total_tokens: sql<number>`COALESCE(SUM(${microdollar_usage.input_tokens} + ${microdollar_usage.output_tokens}), 0)::bigint`,
    })
    .from(microdollar_usage)
    .where(eq(microdollar_usage.kilo_user_id, kiloUserId));

  const totalTokens = Number(totals.total_tokens);

  if (totalTokens < TOKEN_MILESTONE_THRESHOLD) return;

  // 2. Atomic check-and-set: only mark the milestone if it hasn't been set yet.
  //    The WHERE ... IS NULL guard prevents duplicate webhooks from parallel requests.
  const now = new Date().toISOString();
  const updated = await db
    .update(kilocode_users)
    .set({ token_milestone_notified_at: now })
    .where(
      sql`${kilocode_users.id} = ${kiloUserId} AND ${kilocode_users.token_milestone_notified_at} IS NULL`
    )
    .returning({
      id: kilocode_users.id,
      email: kilocode_users.google_user_email,
      name: kilocode_users.google_user_name,
      created_at: kilocode_users.created_at,
    });

  // If no rows were updated, another request already claimed the milestone.
  if (updated.length === 0) return;

  const user = updated[0];

  // 3. Fire the webhook (best-effort, don't throw on failure).
  const payload = {
    event: 'token_milestone_reached',
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      created_at: user.created_at,
    },
    totalTokens,
    milestone: TOKEN_MILESTONE_THRESHOLD,
    timestamp: now,
  };

  try {
    const response = await fetch(TOKEN_MILESTONE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(
        `[TokenMilestone] Webhook returned ${response.status}: ${await response.text()}`
      );
    }
  } catch (error) {
    console.error('[TokenMilestone] Failed to fire webhook', error);
    captureException(error, {
      tags: { source: 'token_milestone_webhook' },
      extra: { kiloUserId, totalTokens },
    });
  }
}
