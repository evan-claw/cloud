import { sql } from 'drizzle-orm';
import type { db } from '@/lib/drizzle';

type DbInstance = typeof db;

type UsageQueryParams = {
  db: DbInstance;
  route: string;
  queryLabel: string;
  scope: 'user' | 'org' | 'admin';
  period: string | null;
  timeoutMs?: number;
};

const DEFAULT_INTERACTIVE_TIMEOUT_MS = 5_000;
const DEFAULT_ADMIN_TIMEOUT_MS = 20_000;

function defaultTimeoutForScope(scope: 'user' | 'org' | 'admin'): number {
  return scope === 'admin' ? DEFAULT_ADMIN_TIMEOUT_MS : DEFAULT_INTERACTIVE_TIMEOUT_MS;
}

export async function timedUsageQuery<T>(
  params: UsageQueryParams,
  queryFn: (tx: DbInstance) => Promise<T>
): Promise<T> {
  const rawTimeout = params.timeoutMs ?? defaultTimeoutForScope(params.scope);
  const timeoutMs = Math.max(0, Math.trunc(rawTimeout));
  if (!Number.isFinite(timeoutMs)) {
    throw new Error(`Invalid statement_timeout: ${String(rawTimeout)}`);
  }
  const start = performance.now();
  let rowCount = 0;

  try {
    const result = await params.db.transaction(async tx => {
      // SET doesn't accept parameterized values in PostgreSQL; timeoutMs is
      // validated as a finite integer above, so raw interpolation is safe here.
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}'`));
      return queryFn(tx as unknown as DbInstance);
    });

    rowCount = Array.isArray(result) ? result.length : 1;
    return result;
  } finally {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    console.log(
      JSON.stringify({
        type: 'usage_query',
        route: params.route,
        queryLabel: params.queryLabel,
        scope: params.scope,
        period: params.period,
        durationMs,
        rowCount,
      })
    );
  }
}
