// Per-IP Durable Object for rate limiting.
// Each IP gets its own DO instance (via idFromName(ip)), giving us
// single-threaded, strongly consistent check-and-increment — no TOCTOU races.
//
// Uses ctx.storage KV API with alarms for automatic expiry.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

const FREE_MODEL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const FREE_MODEL_MAX_REQUESTS = 200;

const PROMOTION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const PROMOTION_MAX_REQUESTS = 10_000;

// Storage keys for the two sliding window timestamp arrays
const FREE_KEY = 'free';
const PROMO_KEY = 'promo';

export type RateLimitResult = {
  allowed: boolean;
  requestCount: number;
};

export class RateLimitDO extends DurableObject<Env> {
  // Read the current window count without modifying state.
  private async peekCount(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = ((await this.ctx.storage.get<number[]>(key)) ?? []).filter(
      t => t >= windowStart
    );
    return timestamps.length;
  }

  // Append a timestamp to the sliding window. No race conditions because
  // the DO serializes all concurrent requests to the same instance.
  private async appendTimestamp(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = ((await this.ctx.storage.get<number[]>(key)) ?? []).filter(
      t => t >= windowStart
    );
    timestamps.push(now);
    await this.ctx.storage.put(key, timestamps);
    this.scheduleCleanup(windowMs);
    return timestamps.length;
  }

  // Check-only — does NOT increment the counter. Used by rate-limit middleware
  // so that the log middleware is the sole place that increments.
  async checkFreeModel(): Promise<RateLimitResult> {
    const count = await this.peekCount(FREE_KEY, FREE_MODEL_WINDOW_MS);
    return { allowed: count < FREE_MODEL_MAX_REQUESTS, requestCount: count };
  }

  async incrementFreeModel(): Promise<void> {
    await this.appendTimestamp(FREE_KEY, FREE_MODEL_WINDOW_MS);
  }

  // Check-only — does NOT increment the counter.
  async checkPromotion(): Promise<RateLimitResult> {
    const count = await this.peekCount(PROMO_KEY, PROMOTION_WINDOW_MS);
    return { allowed: count < PROMOTION_MAX_REQUESTS, requestCount: count };
  }

  async incrementPromotion(): Promise<void> {
    await this.appendTimestamp(PROMO_KEY, PROMOTION_WINDOW_MS);
  }

  // Schedule an alarm to clean up expired entries so the DO can be evicted.
  private scheduleCleanup(windowMs: number) {
    // setAlarm is idempotent if an alarm is already scheduled.
    // Schedule cleanup slightly after the longest window expires.
    void this.ctx.storage.setAlarm(Date.now() + windowMs + 1000);
  }

  override async alarm() {
    const now = Date.now();
    const freeTs = (await this.ctx.storage.get<number[]>(FREE_KEY)) ?? [];
    const promoTs = (await this.ctx.storage.get<number[]>(PROMO_KEY)) ?? [];

    const freeFiltered = freeTs.filter(t => t >= now - FREE_MODEL_WINDOW_MS);
    const promoFiltered = promoTs.filter(t => t >= now - PROMOTION_WINDOW_MS);

    if (freeFiltered.length > 0) {
      await this.ctx.storage.put(FREE_KEY, freeFiltered);
    } else {
      await this.ctx.storage.delete(FREE_KEY);
    }

    if (promoFiltered.length > 0) {
      await this.ctx.storage.put(PROMO_KEY, promoFiltered);
    } else {
      await this.ctx.storage.delete(PROMO_KEY);
    }

    // If there are still entries, re-schedule cleanup
    if (freeFiltered.length > 0 || promoFiltered.length > 0) {
      const nextCleanup = Math.max(FREE_MODEL_WINDOW_MS, PROMOTION_WINDOW_MS);
      await this.ctx.storage.setAlarm(now + nextCleanup + 1000);
    }
  }
}

export function getRateLimitDO(
  env: { RATE_LIMIT_DO: DurableObjectNamespace<RateLimitDO> },
  ip: string
): DurableObjectStub<RateLimitDO> {
  const id = env.RATE_LIMIT_DO.idFromName(ip);
  return env.RATE_LIMIT_DO.get(id);
}
