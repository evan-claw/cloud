# `@kilocode/worker-utils` — Shared Worker Utilities Package

Peer to `@kilocode/db` in `packages/`. Extracts repeating patterns found across 16+ Cloudflare Worker packages into a single shared library.

---

## Motivation

Comprehensive analysis of all worker packages revealed **7 distinct utilities** duplicated across 2–6 packages each. The core algorithm in every case is identical; the only differences are cosmetic (logger choice, log prefix style, sleep mechanism). This creates maintenance burden and inconsistency.

---

## Package Structure

```
packages/worker-utils/
├── package.json          # @kilocode/worker-utils
├── tsconfig.json
└── src/
    ├── index.ts          # Re-exports all public API
    ├── do-retry.ts       # withDORetry + helpers
    ├── validation.ts     # zodJsonValidator (Hono middleware)
    ├── bearer-auth.ts    # createBearerAuthMiddleware
    ├── kilo-token.ts     # validateKiloToken (core parsing only)
    ├── timing-safe.ts    # timingSafeEqual
    ├── response.ts       # resSuccess, resError, types
    └── error.ts          # formatError
```

### Dependencies

```jsonc
// package.json
{
  "name": "@kilocode/worker-utils",
  "dependencies": {
    "jsonwebtoken": "...", // for kilo-token.ts
  },
  "devDependencies": {
    "@types/jsonwebtoken": "...",
    "typescript": "...",
    "hono": "...",
    "zod": "...",
  },
  "peerDependencies": {
    "hono": ">=4", // optional — only needed by validation.ts, bearer-auth.ts
    "zod": ">=3", // optional — only needed by validation.ts
  },
}
```

---

## Module Details

### 1. `do-retry.ts` — Durable Object Retry Wrapper

**Duplication:** 6 copies across `cloud-agent`, `cloud-agent-next`, `cloudflare-webhook-agent-ingest`, `cloudflare-session-ingest`, `cloudflare-code-review-infra`, `kiloclaw`.

**What's identical across all 6:** `DORetryConfig` type, `DEFAULT_CONFIG` values (`maxAttempts=3`, `baseBackoffMs=100`, `maxBackoffMs=5000`), `isRetryableError` (checks `error.retryable === true`), `calculateBackoff` (exponential + full jitter), `withDORetry` signature and retry loop logic.

**What varies:** Logger (`WorkersLogger` vs `console`), sleep mechanism (`scheduler.wait()` vs `setTimeout` vs a shim).

**Design decisions:**

- Default to `console.warn`/`console.error`
- Accept optional `logger?: { warn(msg: string, fields: Record<string, unknown>): void; error(msg: string, fields: Record<string, unknown>): void }` in the config
- Use the `waitMs` shim from `cloudflare-session-ingest` (tries `scheduler.wait()`, falls back to `setTimeout`) — works in both Workers runtime and Node test environments

**Exports:** `withDORetry`, `DORetryConfig`, `isRetryableError`, `calculateBackoff`

**Current locations to replace:**

| Package                           | File                    |
| --------------------------------- | ----------------------- |
| `cloud-agent`                     | `src/utils/do-retry.ts` |
| `cloud-agent-next`                | `src/utils/do-retry.ts` |
| `cloudflare-webhook-agent-ingest` | `src/util/do-retry.ts`  |
| `cloudflare-session-ingest`       | `src/util/do-retry.ts`  |
| `cloudflare-code-review-infra`    | `src/utils/do-retry.ts` |
| `kiloclaw`                        | `src/util/do-retry.ts`  |

**Migration at call sites:** Consumers that use `WorkersLogger` pass an adapter:

```typescript
import { withDORetry } from '@kilocode/worker-utils';
import { logger } from './logger.js';

// Pass structured logger adapter
withDORetry(getStub, operation, 'operationName', {
  logger: {
    warn: (msg, fields) => logger.withFields(fields).warn(msg),
    error: (msg, fields) => logger.withFields(fields).error(msg),
  },
});
```

Consumers using `console` need no changes beyond the import path.

---

### 2. `validation.ts` — Zod JSON Validator (Hono Middleware)

**Duplication:** 2 exact copies in `cloudflare-session-ingest/src/util/validation.ts` and `cloudflare-o11y/src/util/validation.ts`.

**Implementation:** Hono `validator('json', ...)` factory that runs `schema.safeParse(value)` and returns `{ success: false, error, issues }` on failure with status 400.

**Exports:** `zodJsonValidator`

**Current locations to replace:**

| Package                     | File                     |
| --------------------------- | ------------------------ |
| `cloudflare-session-ingest` | `src/util/validation.ts` |
| `cloudflare-o11y`           | `src/util/validation.ts` |

---

### 3. `bearer-auth.ts` — Bearer Auth Middleware Factory

**Duplication:** 4 character-for-character identical copies in `cloudflare-auto-fix-infra`, `cloudflare-auto-triage-infra`, `cloudflare-code-review-infra`, `cloudflare-deploy-infra/builder`.

**Implementation:** Wraps Hono's `bearerAuth({ token })` with:

1. Check that the token env var is non-empty (returns `{ error: 'Unauthorized' }` 401 if missing)
2. Catch `HTTPException` from `bearerAuth` and return `{ error: 'Unauthorized' }` 401

**Design:** Factory function that accepts a token-getter:

```typescript
export function createBearerAuthMiddleware<E extends Record<string, unknown>>(
  getToken: (env: E) => string | undefined
): MiddlewareHandler;
```

**Exports:** `createBearerAuthMiddleware`

**Current locations to replace:**

| Package                           | File           | Lines |
| --------------------------------- | -------------- | ----- |
| `cloudflare-auto-fix-infra`       | `src/index.ts` | 21–40 |
| `cloudflare-auto-triage-infra`    | `src/index.ts` | 25–44 |
| `cloudflare-code-review-infra`    | `src/index.ts` | 38–57 |
| `cloudflare-deploy-infra/builder` | `src/index.ts` | 44–63 |

**Migration example:**

```typescript
import { createBearerAuthMiddleware } from '@kilocode/worker-utils';

app.use(
  '*',
  createBearerAuthMiddleware((env: Env) => env.BACKEND_AUTH_TOKEN)
);
```

---

### 4. `kilo-token.ts` — Core Kilo JWT Validation

**Duplication:** ~4 copies with minor variations in `cloud-agent`, `cloud-agent-next`, `cloudflare-ai-attribution`, `cloudflare-session-ingest`.

**Scope:** Core token parsing only — no Hono middleware, no worker-specific claim validation.

- Extract Bearer token from `Authorization` header
- `jwt.verify(token, secret, { algorithms: ['HS256'] })`
- Check `payload.version === 3`
- Return `{ success, userId, token, botId }` result type
- Map `TokenExpiredError` / `JsonWebTokenError` to appropriate error messages

**Exports:** `validateKiloToken`, `TokenPayload` type, result types

**Current locations to replace:**

| Package                     | File                              | Notes                                        |
| --------------------------- | --------------------------------- | -------------------------------------------- |
| `cloud-agent`               | `src/auth.ts`                     | Direct replacement                           |
| `cloud-agent-next`          | `src/auth.ts`                     | Direct replacement                           |
| `cloudflare-ai-attribution` | `src/util/auth.ts`                | Keeps org-claim Zod validation on top        |
| `cloudflare-session-ingest` | `src/middleware/kilo-jwt-auth.ts` | Keeps user-existence check + KV cache on top |

Each consumer wraps the shared `validateKiloToken` in its own middleware to add worker-specific logic. All existing response interfaces remain unchanged.

---

### 5. `timing-safe.ts` — Timing-Safe String Comparison

**Duplication:** 2 byte-for-byte identical copies (Web Crypto API) in `kiloclaw/src/auth/middleware.ts` and `cloudflare-db-proxy/src/utils/auth.ts`. A third XOR-based variant in `cloudflare-webhook-agent-ingest`.

**Implementation:** Web Crypto API version:

```typescript
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    crypto.subtle.timingSafeEqual(aBytes, aBytes); // constant-time dummy
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}
```

**Exports:** `timingSafeEqual`

**Current locations to replace:**

| Package               | File                                     |
| --------------------- | ---------------------------------------- |
| `kiloclaw`            | `src/auth/middleware.ts` (lines 106–116) |
| `cloudflare-db-proxy` | `src/utils/auth.ts` (lines 54–64)        |

`cloudflare-webhook-agent-ingest` can optionally migrate too (its callers pre-hash to equal-length strings, so the behavior is compatible).

---

### 6. `response.ts` — API Response Helpers

**Duplication:** 2 copies in `cloudflare-ai-attribution/src/util/res.ts` and `cloudflare-webhook-agent-ingest/src/util/res.ts`.

**Implementation:** Use the more precisely typed version from `cloudflare-webhook-agent-ingest` (separate `SuccessResponse<T>` and `ErrorResponse` types):

```typescript
export type SuccessResponse<T> = { success: true; data: T };
export type ErrorResponse = { success: false; error: string };

export function resSuccess<T>(data: T): SuccessResponse<T>;
export function resError(error: string): ErrorResponse;
```

All existing response shapes in consumers remain unchanged — this DRYs the helper, not prescribes a new shape.

**Exports:** `resSuccess`, `resError`, `SuccessResponse`, `ErrorResponse`

**Current locations to replace:**

| Package                           | File              |
| --------------------------------- | ----------------- |
| `cloudflare-ai-attribution`       | `src/util/res.ts` |
| `cloudflare-webhook-agent-ingest` | `src/util/res.ts` |

---

### 7. `error.ts` — Error Formatting Helper

**Duplication:** 2 identical copies in `cloudflare-db-proxy/src/logger.ts` and `cloudflare-app-builder/src/utils/logger.ts`.

**Implementation:**

```typescript
export function formatError(error: unknown): { error: string; stack?: string } {
  if (error instanceof Error) {
    return { error: error.message, stack: error.stack };
  }
  return { error: String(error) };
}
```

**Exports:** `formatError`

**Current locations to replace:**

| Package                  | File                                |
| ------------------------ | ----------------------------------- |
| `cloudflare-db-proxy`    | `src/logger.ts` (lines 28–33)       |
| `cloudflare-app-builder` | `src/utils/logger.ts` (lines 31–36) |

---

## Patterns Considered but NOT Extracted

| Pattern                                          | Reason                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| **Sentry setup**                                 | Only 1 worker has full integration. Not enough duplication.           |
| **Logger setup** (`WorkersLogger` instantiation) | Each worker defines unique tag types. Inherently per-worker.          |
| **Env/Bindings types**                           | Completely different per worker. Not extractable.                     |
| **Internal API key middleware**                  | Only 2 workers, and they differ (timing-safe vs plain comparison).    |
| **Fly API client** (`flyFetch`/`assertOk`)       | Only used within `kiloclaw`. Internal duplication, not cross-package. |
| **`withTimeout` / `AbortSignal.timeout`**        | Only 1 shared utility in `cloud-agent-next`. Not duplicated.          |

---

## Migration Order

1. Create `packages/worker-utils/` skeleton: `package.json`, `tsconfig.json`, `src/index.ts`
2. Implement all 7 modules with exports
3. Move `do-retry.test.ts` from `cloudflare-session-ingest` into `packages/worker-utils/` (it has the `scheduler` shim tests — most robust)
4. Add basic unit tests for `timingSafeEqual`, `formatError`, `zodJsonValidator`, `validateKiloToken`, `createBearerAuthMiddleware`
5. Add `"@kilocode/worker-utils": "workspace:*"` to each consuming worker's `package.json`
6. Replace local imports in each worker, delete local copies
7. `pnpm install` to link
8. `pnpm typecheck` to verify
9. Run tests for each affected worker

---

## Test Strategy

- Move the existing `do-retry.test.ts` from `cloudflare-session-ingest` (which tests the `scheduler` shim path) into `packages/worker-utils/`
- Add unit tests for every exported function
- Existing worker tests continue to pass since all interfaces remain unchanged
- The `kiloclaw/src/test-setup.ts` polyfill for `crypto.subtle.timingSafeEqual` may be needed in the worker-utils test setup as well

---

## Summary

| Module           | Copies Found                    | Consumers to Update                                                                                          |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `do-retry.ts`    | 6                               | `cloud-agent`, `cloud-agent-next`, `webhook-agent-ingest`, `session-ingest`, `code-review-infra`, `kiloclaw` |
| `validation.ts`  | 2                               | `session-ingest`, `o11y`                                                                                     |
| `bearer-auth.ts` | 4                               | `auto-fix-infra`, `auto-triage-infra`, `code-review-infra`, `deploy-infra/builder`                           |
| `kilo-token.ts`  | 4                               | `cloud-agent`, `cloud-agent-next`, `ai-attribution`, `session-ingest`                                        |
| `timing-safe.ts` | 2+                              | `kiloclaw`, `db-proxy`                                                                                       |
| `response.ts`    | 2                               | `ai-attribution`, `webhook-agent-ingest`                                                                     |
| `error.ts`       | 2                               | `db-proxy`, `app-builder`                                                                                    |
| **Total**        | **22+ local copies eliminated** | **12 unique worker packages touched**                                                                        |
