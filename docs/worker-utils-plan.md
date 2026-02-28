# `@kilocode/worker-utils` — Extraction Plan

## Overview

Create `packages/worker-utils/` as the second shared package (alongside `packages/db/`). All Cloudflare workers will import common utilities from `@kilocode/worker-utils` instead of maintaining local copies.

## Package Setup

- **Location:** `packages/worker-utils/`
- **Package name:** `@kilocode/worker-utils`
- **Files:** `package.json`, `tsconfig.json`, `src/index.ts` (barrel export)
- **Build:** unbundled TypeScript (same pattern as `packages/db/`)

### Dependencies

worker-utils will own these deps (moved from individual workers):

| Dependency  | Used by                                                                                    | Previously in                             |
| ----------- | ------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `aws4fetch` | `createR2Client`                                                                           | cloud-agent, cloud-agent-next             |
| `hono`      | `backendAuthMiddleware`, `zodJsonValidator`, `createErrorHandler`, `createNotFoundHandler` | (peer dep — all workers already have it)  |
| `zod`       | `zodJsonValidator`                                                                         | (peer dep — most workers already have it) |

After migration, remove `aws4fetch` from `cloud-agent/package.json` and `cloud-agent-next/package.json`.

### Cleanup: pre-existing dead deps (unrelated but found during audit)

| Worker                    | Dead dependency                        |
| ------------------------- | -------------------------------------- |
| cloudflare-o11y           | `@hono/zod-validator` (never imported) |
| cloudflare-auto-fix-infra | `zod` (never imported)                 |

---

## Candidates

### 1. `withDORetry` — Durable Object retry with exponential backoff

- **Source of truth:** `cloud-agent-next/src/utils/do-retry.ts`
- **Copies to replace (6):** cloud-agent, cloud-agent-next, session-ingest, webhook-agent-ingest, code-review-infra, kiloclaw
- **Unification:** Accept an optional `logger?: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }` parameter. Default to `console`. This removes the only meaningful difference between copies (console vs workers-tagged-logger).
- **Exports:** `withDORetry`, `DORetryConfig`, `DEFAULT_DO_RETRY_CONFIG`

### 2. `backendAuthMiddleware` — Hono bearer auth against a backend token

- **Source of truth:** `cloudflare-code-review-infra/src/index.ts` (lines 38-57)
- **Copies to replace (4):** code-review-infra, deploy-builder, auto-triage, auto-fix (inline in each `index.ts`)
- **Unification:** Consumer passes a getter function `getToken: (c) => string | undefined` instead of hardcoding `c.env.BACKEND_AUTH_TOKEN`. This keeps the middleware generic across different env shapes.
- **Exports:** `backendAuthMiddleware`

### 3. `withTimeout` — Async operation timeout wrapper

- **Source of truth:** `cloud-agent-next/src/utils/timeout.ts`
- **Copies to replace (2):** cloud-agent, cloud-agent-next (byte-identical)
- **Exports:** `withTimeout`

### 4. `createR2Client` — R2 presigned URL client factory

- **Source of truth:** `cloud-agent-next/src/utils/r2-client.ts`
- **Copies to replace (2):** cloud-agent, cloud-agent-next (byte-identical)
- **Dep moved:** `aws4fetch` moves from worker package.json to worker-utils
- **Exports:** `createR2Client`, `R2Client`, `R2ClientConfig`

### 5. `resSuccess` / `resError` — Typed JSON response helpers

- **Source of truth:** `cloudflare-webhook-agent-ingest/src/util/res.ts`
- **Copies to replace (2):** webhook-agent-ingest, ai-attribution
- **Unification:** Use the stricter discriminated union types from webhook-agent-ingest (`{ success: true, data: T }` | `{ success: false, error: string }`). Update ai-attribution's usage to match.
- **Exports:** `resSuccess`, `resError`, `SuccessResponse`, `ErrorResponse`, `ApiResponse`

### 6. `zodJsonValidator` — Hono Zod JSON body validator middleware

- **Source of truth:** `cloudflare-o11y/src/util/validation.ts`
- **Copies to replace (2):** o11y, session-ingest (identical modulo whitespace)
- **Exports:** `zodJsonValidator`

### 7. `timingSafeEqual` — Timing-safe string comparison

- **Source of truth:** `kiloclaw/src/auth/middleware.ts` (lines 105-115)
- **Copies to replace (3):** kiloclaw (inline), db-proxy (inline), webhook-agent-ingest (different impl using manual XOR)
- **Unification:** Use the `crypto.subtle.timingSafeEqual` implementation (kiloclaw/db-proxy version). Replace webhook-agent-ingest's manual XOR version.
- **Exports:** `timingSafeEqual`

### 8. `formatError` — Error formatting for logging

- **Source of truth:** `cloudflare-db-proxy/src/logger.ts`
- **Copies to replace (2):** db-proxy, app-builder
- **Exports:** `formatError`

### 9. `extractBearerToken` — Strip `"Bearer "` prefix from auth header

- **Source of truth:** New utility (trivial function, standardize the 6+ inline `.slice(7)` / `.substring(7)` copies)
- **Copies to replace (6+):** cloud-agent-next, session-ingest, ai-attribution, db-proxy, app-builder, kiloclaw
- **Exports:** `extractBearerToken`

### 10. Encryption utilities

- **Source of truth:** `src/lib/encryption.ts` (Next.js app) — rewrite as proper TypeScript in worker-utils using Web Crypto API
- **Copies to replace (3+):** cloud-agent (re-export), cloud-agent-next (re-export), kiloclaw (standalone `node:crypto` copy)
- **Additional consumer:** The Next.js app (`src/lib/encryption.js`) will also import from `@kilocode/worker-utils` and its local copy gets deleted.
- **Unification:** Port to Web Crypto API so it works in both Workers and Node.js without `node:crypto`. Kiloclaw's standalone copy gets replaced.
- **Exports:** `decryptWithPrivateKey`, `decryptSecrets`, `mergeEnvVarsWithSecrets`, `EncryptionConfigurationError`, `EncryptionFormatError`, `EncryptedEnvelope`

### 11. `createErrorHandler` — Hono `app.onError` factory

- **Source of truth:** New utility abstracting the pattern from 8 workers
- **Signature:** `createErrorHandler(logger?: { error: (...args: unknown[]) => void })` — returns a Hono `ErrorHandler` that logs the error and returns `{ error: 'Internal server error' }` with status 500.
- **Copies to replace (8+):** Inline `app.onError` in cloud-agent-next, code-review-infra, deploy-builder, deploy-dispatcher, db-proxy, webhook-agent-ingest, auto-triage, auto-fix, ai-attribution
- **Exports:** `createErrorHandler`

### 12. `createNotFoundHandler` — Hono `app.notFound` factory

- **Source of truth:** New utility abstracting the pattern from 7 workers
- **Signature:** `createNotFoundHandler()` — returns a Hono `NotFoundHandler` that returns `{ error: 'Not found' }` with status 404.
- **Copies to replace (7+):** Inline `app.notFound` in cloud-agent-next, code-review-infra, deploy-builder, db-proxy, webhook-agent-ingest, auto-triage, auto-fix, ai-attribution
- **Exports:** `createNotFoundHandler`

### 13. `Owner` type

- **Source of truth:** `cloudflare-code-review-infra/src/types.ts`
- **Copies to replace (3):** code-review-infra, auto-triage, auto-fix (identical)
- **Exports:** `Owner`

### 14. `MCPServerConfig` type

- **Source of truth:** `cloudflare-code-review-infra/src/types.ts`
- **Copies to replace (2):** code-review-infra, auto-triage (identical)
- **Exports:** `MCPServerConfig`

---

## Execution Order

1. **Create the package** — `packages/worker-utils/` with package.json, tsconfig.json, src/index.ts
2. **Add utilities one at a time** (in order 1→14), write each module, export from barrel
3. **Migrate each worker** — replace local copy with import from `@kilocode/worker-utils`, delete local file
4. **Remove moved deps** — delete `aws4fetch` from cloud-agent and cloud-agent-next package.json
5. **Remove dead deps** — delete `@hono/zod-validator` from o11y, `zod` from auto-fix
6. **Run `pnpm typecheck`** after each worker migration to catch breakage early
7. **Final `pnpm typecheck`** across the entire repo
