// Rate limiting via Durable Object.
// Each IP gets its own DO instance for strongly-consistent, atomic
// check-and-increment with no TOCTOU race conditions.

import { getRateLimitDO } from '../dos/RateLimitDO';
export type { RateLimitResult } from '../dos/RateLimitDO';

type DOEnv = { RATE_LIMIT_DO: Parameters<typeof getRateLimitDO>[0]['RATE_LIMIT_DO'] };

export async function checkFreeModelRateLimit(env: DOEnv, ip: string) {
  const stub = getRateLimitDO(env, ip);
  return stub.checkFreeModel();
}

export async function checkPromotionLimit(env: DOEnv, ip: string) {
  const stub = getRateLimitDO(env, ip);
  return stub.checkPromotion();
}

export async function incrementFreeModelUsage(env: DOEnv, ip: string) {
  const stub = getRateLimitDO(env, ip);
  await stub.incrementFreeModel();
}

export async function incrementPromotionUsage(env: DOEnv, ip: string) {
  const stub = getRateLimitDO(env, ip);
  await stub.incrementPromotion();
}
