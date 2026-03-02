// KV-backed sliding window rate limiter.
// Stores an array of request timestamps (ms) under each key.
// The array is pruned to the current window on every read.

export type RateLimitResult = {
  allowed: boolean;
  requestCount: number;
};

const FREE_MODEL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const FREE_MODEL_MAX_REQUESTS = 200;

const PROMOTION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const PROMOTION_MAX_REQUESTS = 10_000;

function freeModelKey(ip: string) {
  return `rl:free:${ip}`;
}

function promotionKey(ip: string) {
  return `rl:promo:${ip}`;
}

async function readTimestamps(kv: KVNamespace, key: string): Promise<number[]> {
  const raw = await kv.get(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === 'number');
  } catch {
    return [];
  }
}

async function checkWindow(
  kv: KVNamespace,
  key: string,
  windowMs: number,
  maxRequests: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const timestamps = await readTimestamps(kv, key);
  const inWindow = timestamps.filter(t => t >= windowStart);
  return { allowed: inWindow.length < maxRequests, requestCount: inWindow.length };
}

async function incrementWindow(kv: KVNamespace, key: string, windowMs: number): Promise<void> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const timestamps = await readTimestamps(kv, key);
  const inWindow = timestamps.filter(t => t >= windowStart);
  inWindow.push(now);
  // TTL = window duration in seconds — old entries are irrelevant past the window.
  await kv.put(key, JSON.stringify(inWindow), { expirationTtl: Math.ceil(windowMs / 1000) });
}

export async function checkFreeModelRateLimit(
  kv: KVNamespace,
  ip: string
): Promise<RateLimitResult> {
  return checkWindow(kv, freeModelKey(ip), FREE_MODEL_WINDOW_MS, FREE_MODEL_MAX_REQUESTS);
}

export async function checkPromotionLimit(kv: KVNamespace, ip: string): Promise<RateLimitResult> {
  return checkWindow(kv, promotionKey(ip), PROMOTION_WINDOW_MS, PROMOTION_MAX_REQUESTS);
}

export async function incrementFreeModelUsage(kv: KVNamespace, ip: string): Promise<void> {
  await incrementWindow(kv, freeModelKey(ip), FREE_MODEL_WINDOW_MS);
}

export async function incrementPromotionUsage(kv: KVNamespace, ip: string): Promise<void> {
  await incrementWindow(kv, promotionKey(ip), PROMOTION_WINDOW_MS);
}
