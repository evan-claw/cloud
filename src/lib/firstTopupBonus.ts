import type { User } from '@kilocode/db/schema';
import { grantCreditForCategory } from './promotionalCredits';
import { summarizeUserPayments } from '@/lib/creditTransactions';
import { db } from '@/lib/drizzle';
import { FIRST_TOPUP_BONUS_AMOUNT } from '@/lib/constants';
import { sendFirstTopupBonusEmail } from '@/lib/email';

export async function processFirstTopupBonus(user: User) {
  // this is run after topping up, so a user which has done their first
  // topup will have exactly one topup
  // Uses primary db for read-after-write consistency (payment was just inserted)
  const paymentsSummary = await summarizeUserPayments(user.id, db);
  if (paymentsSummary.payments_count !== 1) return;

  const result = await grantCreditForCategory(user, {
    credit_category: 'first-topup-bonus',
    counts_as_selfservice: false,
    amount_usd: FIRST_TOPUP_BONUS_AMOUNT(new Date(Date.now() - 15 * 60 * 1000)), //15min grace period
  });

  if (result.success) {
    const bonusAmount = result.amount_usd;
    const firstPaymentAmount = paymentsSummary.payments_total_microdollars / 1_000_000;
    const totalAmount = firstPaymentAmount + bonusAmount;

    try {
      await sendFirstTopupBonusEmail({
        to: user.google_user_email,
        bonus_amount: bonusAmount.toFixed(2),
        total_amount: totalAmount.toFixed(2),
      });
    } catch (error) {
      console.error('[processFirstTopupBonus] Failed to send bonus email:', error);
    }
  }
}
