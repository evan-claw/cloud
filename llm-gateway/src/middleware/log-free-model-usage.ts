import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';
import { isKiloFreeModel, isFreeModel } from '../lib/models';
import { isAnonymousContext } from '../lib/anonymous';
import { incrementFreeModelUsage, incrementPromotionUsage } from '../lib/rate-limit';
import { getWorkerDb } from '@kilocode/db/client';
import { free_model_usage } from '@kilocode/db/schema';

// Runs after rate limit + auth checks pass.
// Fires two background tasks:
//   1. DB insert into free_model_usage (for analytics)
//   2. KV increment for rate limit sliding window
// Both are non-blocking via ctx.waitUntil().
export const logFreeModelUsageMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const resolvedModel = c.get('resolvedModel');

  if (!isFreeModel(resolvedModel)) {
    return next();
  }

  const ip = c.get('clientIp');
  const user = c.get('user');
  const kiloUserId = isAnonymousContext(user) ? undefined : user.id;

  // Fire background tasks — do not await
  c.executionCtx.waitUntil(
    Promise.all([
      // DB insert
      (async () => {
        try {
          const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
          await db.insert(free_model_usage).values({
            ip_address: ip,
            model: resolvedModel,
            kilo_user_id: kiloUserId ?? null,
          });
        } catch (err) {
          console.error('[logFreeModelUsageMiddleware] DB insert failed', err);
        }
      })(),
      // KV increment for free model rate limit
      (async () => {
        try {
          if (isKiloFreeModel(resolvedModel)) {
            await incrementFreeModelUsage(c.env, ip);
          }
        } catch (err) {
          console.error('[logFreeModelUsageMiddleware] KV increment failed', err);
        }
      })(),
      // KV increment for promotion limit (anonymous users only)
      (async () => {
        try {
          if (isAnonymousContext(user)) {
            await incrementPromotionUsage(c.env, ip);
          }
        } catch (err) {
          console.error('[logFreeModelUsageMiddleware] promotion KV increment failed', err);
        }
      })(),
    ])
  );

  return next();
});
