// Shared test infrastructure for integration tests.
// Re-exports helpers from unit tests and adds dispatch + DB mock + fixtures.

export {
  signToken,
  makeEnv,
  fakeExecutionCtx,
  chatRequest,
  makeSSEStream,
  sseChunk,
  sseDone,
  readSSEEvents,
  TEST_SECRET,
} from '../unit/helpers';

// ── Dispatch helper ───────────────────────────────────────────────────────────
// Dynamically imports the worker and calls its fetch method.

import { makeEnv, fakeExecutionCtx } from '../unit/helpers';
import type { Env } from '../../src/env';

export async function dispatch(req: Request, envOverrides: Partial<Record<string, unknown>> = {}) {
  const { default: worker } = await import('../../src/index');
  const env = makeEnv(envOverrides);
  return worker.fetch!(
    req as Request<unknown, IncomingRequestCfProperties>,
    env,
    fakeExecutionCtx()
  );
}

// ── User fixtures ─────────────────────────────────────────────────────────────

export const VALID_USER = {
  id: 'user-1',
  google_user_email: 'test@example.com',
  api_token_pepper: null as string | null,
  total_microdollars_acquired: 10_000_000, // $10
  microdollars_used: 0,
  is_admin: false,
};

export const VALID_USER_ZERO_BALANCE = {
  ...VALID_USER,
  id: 'user-zero',
  total_microdollars_acquired: 0,
  microdollars_used: 0,
};

export const VALID_USER_NEW = {
  ...VALID_USER_ZERO_BALANCE,
  id: 'user-new',
};

// ── Drizzle table name helper ─────────────────────────────────────────────────
// Drizzle table objects store the SQL table name under Symbol.for('drizzle:Name').

const DRIZZLE_NAME = Symbol.for('drizzle:Name');

export function getTableName(table: unknown): string {
  if (table && typeof table === 'object' && DRIZZLE_NAME in table) {
    return (table as Record<symbol, string>)[DRIZZLE_NAME] ?? '';
  }
  return '';
}

// ── DB mock query chain helper ────────────────────────────────────────────────
// Creates a thenable-proxy that supports arbitrary drizzle method chaining
// (.where, .limit, .orderBy, .innerJoin, .leftJoin, etc.) and resolves to
// `result` when awaited.

export function chainResult(result: unknown) {
  const resolved = Promise.resolve(result);
  const proxy: unknown = new Proxy(Function, {
    get(_target, prop) {
      // Make the proxy thenable — when awaited, resolve to `result`
      if (prop === 'then') return resolved.then.bind(resolved);
      if (prop === 'catch') return resolved.catch.bind(resolved);
      if (prop === 'finally') return resolved.finally.bind(resolved);
      // All other method calls return the same chainable proxy
      return () => proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

// ── Standard module mocks ─────────────────────────────────────────────────────
// Common mock definitions reused across test files.

export const WORKER_UTILS_MOCK = {
  userExistsWithCache: async () => true,
  extractBearerToken: (header: string | undefined) => {
    if (!header) return null;
    const parts = header.split(' ');
    return parts.length === 2 && parts[0].toLowerCase() === 'bearer' ? parts[1] : null;
  },
  verifyKiloToken: async () => {
    throw new Error('should not be called directly');
  },
};

export const ABUSE_SERVICE_MOCK = {
  classifyAbuse: async () => null,
  reportAbuseCost: async () => null,
};

export const ENCRYPTION_MOCK = {
  timingSafeEqual: (a: string, b: string) => a === b,
};

// ── DO namespace factory ──────────────────────────────────────────────────────

export function makeFakeDONamespace(
  opts: {
    freeModelBlocked?: Set<string>;
    promotionBlocked?: Set<string>;
  } = {}
) {
  const freeModelBlocked = opts.freeModelBlocked ?? new Set();
  const promotionBlocked = opts.promotionBlocked ?? new Set();

  const createStub = (ip: string) => ({
    checkFreeModel: async () => ({
      allowed: !freeModelBlocked.has(ip),
      requestCount: freeModelBlocked.has(ip) ? 200 : 0,
    }),
    checkPromotion: async () => ({
      allowed: !promotionBlocked.has(ip),
      requestCount: promotionBlocked.has(ip) ? 10000 : 0,
    }),
    incrementFreeModel: async () => {},
    incrementPromotion: async () => {},
  });

  let lastIp = '0.0.0.0';

  return {
    idFromName(name: string) {
      lastIp = name;
      return {} as DurableObjectId;
    },
    newUniqueId() {
      return {} as DurableObjectId;
    },
    idFromString() {
      return {} as DurableObjectId;
    },
    getByName(name: string) {
      return createStub(name) as unknown as DurableObjectStub;
    },
    get() {
      return createStub(lastIp) as unknown as DurableObjectStub;
    },
    jurisdiction() {
      return this;
    },
  } as unknown as Env['RATE_LIMIT_DO'];
}
