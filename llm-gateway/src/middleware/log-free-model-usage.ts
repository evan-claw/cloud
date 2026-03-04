import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';
import { isKiloFreeModel } from '../lib/models';
import { isAnonymousContext } from '../lib/anonymous';
import { incrementFreeModelUsage, incrementPromotionUsage } from '../lib/rate-limit';
import { free_model_usage } from '@kilocode/db/schema';

// Runs after rate limit + auth checks pass.
//
// The DB insert into free_model_usage is awaited synchronously (before the
// upstream request), matching the reference implementation (route.ts:220)
// where `await logFreeModelRequest(...)` runs before processing. This ensures
// the rate-limit entry is counted even if the upstream request fails.
//
// DO increments are non-blocking — they're a worker-specific optimization.
export const logFreeModelUsageMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const resolvedModel = c.get('resolvedModel');

  // Only log for Kilo-hosted free models, matching the reference implementation.
  // OpenRouter :free suffix models are not tracked in free_model_usage.
  if (!isKiloFreeModel(resolvedModel)) {
    return next();
  }

  const ip = c.get('clientIp');
  const user = c.get('user');
  const kiloUserId = isAnonymousContext(user) ? undefined : user.id;

  // DB insert — awaited before processing, matching the reference.
  try {
    const db = c.get('db');
    await db.insert(free_model_usage).values({
      ip_address: ip,
      model: resolvedModel,
      kilo_user_id: kiloUserId ?? null,
    });
  } catch (err) {
    console.error('[logFreeModelUsageMiddleware] DB insert failed', err);
  }

  // DO increments — non-blocking, worker-specific optimization.
  c.executionCtx.waitUntil(
    Promise.all([
      (async () => {
        try {
          await incrementFreeModelUsage(c.env, ip);
        } catch (err) {
          console.error('[logFreeModelUsageMiddleware] DO increment failed', err);
        }
      })(),
      (async () => {
        try {
          if (isAnonymousContext(user)) {
            await incrementPromotionUsage(c.env, ip);
          }
        } catch (err) {
          console.error('[logFreeModelUsageMiddleware] promotion DO increment failed', err);
        }
      })(),
    ])
  );

  return next();
});
