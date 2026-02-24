import { getEnvVariable } from '@/lib/dotenvx';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg, { types } from 'pg';
import assert from 'node:assert';
import * as schema from '../db/schema';
import { computeDatabaseUrl, getDatabaseClientConfig } from './database-url';
export const { Client, Pool } = pg;
import { attachDatabasePool } from '@vercel/functions';
const { POSTGRES_CONNECT_TIMEOUT, POSTGRES_MAX_QUERY_TIME, DEBUG_QUERY_LOGGING, VERCEL_REGION } =
  process.env;

const POSTGRES_URL = getEnvVariable('POSTGRES_URL');

// Environment validation
if (!POSTGRES_URL) throw new Error('POSTGRES_URL not configured');
if (!POSTGRES_CONNECT_TIMEOUT) throw new Error('POSTGRES_CONNECT_TIMEOUT not configured');
if (!POSTGRES_MAX_QUERY_TIME) throw new Error('POSTGRES_MAX_QUERY_TIME not configured');

// Base url + test worker suffix (shared) - includes env validation internally
let postgresUrl = computeDatabaseUrl();

const IS_SCRIPT = process.env.IS_SCRIPT === 'true';

if (IS_SCRIPT) {
  // For scripts, we use a different connection string to avoid conflicts with the main app
  // This allows us to run scripts without affecting the main database connection
  assert(getEnvVariable('POSTGRES_SCRIPT_URL'), 'POSTGRES_SCRIPT_URL must be set for scripts');
  postgresUrl = getEnvVariable('POSTGRES_SCRIPT_URL');
}

// Drizzle requires this for BigInts
// https://orm.drizzle.team/docs/column-types/pg#bigint
types.setTypeParser(types.builtins.INT8, val => BigInt(val));

const appName = IS_SCRIPT ? 'kilocode-script' : 'kilocode-backend';

export function isUSRegion(): boolean {
  if (!VERCEL_REGION) return false;
  return (
    VERCEL_REGION.startsWith('sfo') ||
    VERCEL_REGION.startsWith('iad') ||
    VERCEL_REGION.startsWith('pdx') ||
    VERCEL_REGION.startsWith('cle')
  );
}

/**
 * Get the read replica URL based on deployment region.
 * - US deployments use the US replica (San Francisco) for lower latency
 * - EU deployments use the primary (Frankfurt) for reads
 * - Falls back to primary if no replica URL is configured
 */
function getReplicaUrl(): string {
  const replicaUrl = getEnvVariable('POSTGRES_REPLICA_US_URL');

  // If we're in a US region and have a replica configured, use it
  if (isUSRegion() && replicaUrl) {
    return replicaUrl;
  }

  // Otherwise, use the primary for reads (EU region or no replica configured)
  return postgresUrl;
}

// Primary pool - always points to Frankfurt (writes go here)
export const pool = new Pool({
  ...getDatabaseClientConfig(postgresUrl),
  max: 100,
  connectionTimeoutMillis: Number.parseInt(POSTGRES_CONNECT_TIMEOUT || '30000'),
  idleTimeoutMillis: 3000,
  application_name: appName,
});

// Replica pool - points to US replica in US regions, primary in EU regions
const replicaUrl = getReplicaUrl();
export const usesSeparateReplica = replicaUrl !== postgresUrl;

const replicaPool = usesSeparateReplica
  ? new Pool({
      ...getDatabaseClientConfig(replicaUrl),
      max: 100,
      connectionTimeoutMillis: Number.parseInt(POSTGRES_CONNECT_TIMEOUT || '30000'),
      idleTimeoutMillis: 3000,
      application_name: `${appName}-replica`,
    })
  : pool; // Reuse primary pool if no separate replica

// Attach pools to ensure idle connections close before suspension
// Skip in test environment as it interferes with Jest's cleanup
if (process.env.NODE_ENV !== 'test') {
  attachDatabasePool(pool);
  if (usesSeparateReplica) {
    attachDatabasePool(replicaPool);
  }
}

pool.on('error', err => {
  console.error('Unexpected error on idle client (primary)', err);
  process.exit(-1);
});

if (usesSeparateReplica) {
  replicaPool.on('error', err => {
    console.error('Unexpected error on idle client (replica)', err);
    process.exit(-1);
  });
}

/**
 * Primary database instance - use for all writes (INSERT, UPDATE, DELETE)
 * and for reads that require strong consistency (read-after-write).
 *
 * This always connects to the primary database in Frankfurt.
 */
const primaryDb = drizzle(pool, { schema, logger: !!DEBUG_QUERY_LOGGING });

/**
 * Read replica database instance - use for read-only queries that can
 * tolerate slight replication lag (typically <100ms).
 *
 * In US regions, this connects to the San Francisco replica for lower latency.
 * In EU regions, this connects to the primary (Frankfurt).
 *
 * Example usage:
 * ```
 * // Read from replica (fast for US users)
 * const users = await readDb.select().from(kilocode_users);
 *
 * // Write to primary
 * await db.insert(kilocode_users).values({ ... });
 *
 * // Read-after-write: use primary for consistency
 * await db.insert(kilocode_users).values({ ... });
 * const newUser = await db.select().from(kilocode_users).where(...);
 * ```
 */
export const readDb = drizzle(replicaPool, { schema, logger: !!DEBUG_QUERY_LOGGING });

/**
 * Default database instance - connects to the primary database.
 * Use this for writes and for reads that need strong consistency.
 *
 * For read-heavy operations that can tolerate replication lag,
 * consider using `readDb` instead for better performance in US regions.
 */
export const db = primaryDb;
export { sql };

// Helper for automatically updating the deleted_at column with database server time
export const auto_deleted_at = { deleted_at: sql`now()` };

// Test cleanup functions
// NOTE: With this simplified setup, the connection is created eagerly and not reset.
// Tests should not rely on closing and reopening the connection within the same process.

export async function closeAllDrizzleConnections(): Promise<void> {
  await pool.end();
  if (usesSeparateReplica) {
    await replicaPool.end();
  }
}

export type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function cleanupDbForTest(): Promise<void> {
  // Use primary for test cleanup to ensure consistency
  const { rows: tables } = await primaryDb.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' and tablename != 'migrations'`
  );

  const truncates = tables
    .map(({ tablename }) => `TRUNCATE TABLE "${tablename}" RESTART IDENTITY CASCADE;\n`)
    .join('');
  await primaryDb.execute(sql.raw(truncates));
}
