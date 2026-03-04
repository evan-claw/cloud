// Promotion helpers — direct port of:
//   src/lib/code-reviews/core/constants.ts  (isActiveReviewPromo)
//   src/lib/promotions/cloud-agent-promo.ts (isActiveCloudAgentPromo)
//
// Both promotions have expired (review: 2026-02-25, cloud-agent: 2026-02-28).

export function isActiveReviewPromo(_botId: string | undefined, _model: string): boolean {
  return false; // Promo ended 2026-02-25
}

export function isActiveCloudAgentPromo(_tokenSource: string | undefined, _model: string): boolean {
  return false; // Promo ended 2026-02-28
}
