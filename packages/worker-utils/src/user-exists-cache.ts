import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import type { WorkerDb } from '@kilocode/db';

type KVLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

const TTL_EXISTS_SECONDS = 24 * 60 * 60; // 24h positive cache
const TTL_NOT_FOUND_SECONDS = 5 * 60; // 5m negative cache — rate-limits DB hits from deleted users

function cacheKey(userId: string) {
  return `user-exists:${userId}`;
}

/**
 * Check whether a user exists using a KV existence cache in front of Postgres.
 *
 * - Positive cache ('1'): returns true immediately, no DB query.
 * - Negative cache ('0'): returns false immediately, no DB query.
 * - Cache miss: queries the DB, then updates the cache (fire-and-forget).
 */
export async function userExistsWithCache(
  cache: KVLike,
  db: WorkerDb,
  userId: string
): Promise<boolean> {
  const cached = await cache.get(cacheKey(userId));

  if (cached === '1') return true;
  if (cached === '0') return false;

  const rows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  const exists = rows[0] !== undefined;
  void cache.put(cacheKey(userId), exists ? '1' : '0', {
    expirationTtl: exists ? TTL_EXISTS_SECONDS : TTL_NOT_FOUND_SECONDS,
  });

  return exists;
}
