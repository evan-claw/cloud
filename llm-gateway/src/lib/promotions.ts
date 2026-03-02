// Promotion helpers — direct port of:
//   src/lib/code-reviews/core/constants.ts  (isActiveReviewPromo)
//   src/lib/promotions/cloud-agent-promo.ts (isActiveCloudAgentPromo)

const REVIEW_PROMO_MODEL = 'anthropic/claude-sonnet-4.6';
const REVIEW_PROMO_END = '2026-02-25T14:00:00Z';

export function isActiveReviewPromo(botId: string | undefined, model: string): boolean {
  if (botId !== 'reviewer') return false;
  if (model !== REVIEW_PROMO_MODEL) return false;
  return Date.now() < Date.parse(REVIEW_PROMO_END);
}

const CLOUD_AGENT_PROMO_MODEL = 'anthropic/claude-sonnet-4.6';
const CLOUD_AGENT_PROMO_START = '2026-02-26T08:00:00Z';
const CLOUD_AGENT_PROMO_END = '2026-02-28T08:00:00Z';

export function isActiveCloudAgentPromo(tokenSource: string | undefined, model: string): boolean {
  if (tokenSource !== 'cloud-agent') return false;
  if (model !== CLOUD_AGENT_PROMO_MODEL) return false;
  const now = Date.now();
  return now >= Date.parse(CLOUD_AGENT_PROMO_START) && now < Date.parse(CLOUD_AGENT_PROMO_END);
}
