# Plan: `cloudflare-llm-gateway` Worker

## Goal

Create a Cloudflare Worker to handle all LLM gateway routes, replacing the planned `kilocode-gateway` Vercel project. This moves the heaviest API traffic off Vercel for better latency, cost, and scalability.

## Routes

| Route                                | Method | Description                        |
| ------------------------------------ | ------ | ---------------------------------- |
| `/api/openrouter/chat/completions`   | POST   | Main LLM chat completions proxy    |
| `/api/gateway/chat/completions`      | POST   | Alias of above                     |
| `/api/openrouter/models`             | GET    | Enhanced model list                |
| `/api/openrouter/providers`          | GET    | Provider list (cached)             |
| `/api/openrouter/models-by-provider` | GET    | Models grouped by provider         |
| `/api/models/stats`                  | GET    | All active model statistics        |
| `/api/models/stats/:slug`            | GET    | Single model stats                 |
| `/api/modelstats`                    | GET    | Public cost-per-model stats (CORS) |
| `/api/models/up`                     | GET    | Model health check                 |
| `/api/defaults`                      | GET    | Default model for user             |

**Excluded:** `/api/code-indexing/upsert-by-file` (separate Worker later), `/api/fim/completions` (stays on global-app).

## Directory Structure

```
cloudflare-llm-gateway/
├── package.json              # hono, jose, pg, zod, @kilocode/db, eventsource-parser, ai, @ai-sdk/*
├── wrangler.jsonc
├── tsconfig.json
├── worker-configuration.d.ts
├── vitest.config.ts
├── src/
│   ├── index.ts              # Hono app entrypoint, Sentry instrumented
│   ├── types.ts              # CloudflareEnv (Hyperdrive, secrets, KV)
│   ├── routes/
│   │   ├── chat-completions.ts   # POST handler — the main proxy
│   │   ├── models.ts             # GET /models, /providers, /models-by-provider, /models/stats
│   │   ├── modelstats.ts         # GET /modelstats (public CORS)
│   │   ├── health.ts             # GET /models/up
│   │   └── defaults.ts           # GET /defaults
│   ├── auth/
│   │   ├── jwt.ts                # jose-based JWT verification (reuse KiloClaw pattern)
│   │   └── middleware.ts         # Hono middleware: user lookup, pepper check, anonymous fallback
│   ├── db/
│   │   └── index.ts              # getWorkerDb from @kilocode/db/client, query helpers
│   ├── lib/
│   │   ├── providers/            # getProvider, openRouterRequest, applyProviderSpecificLogic + per-provider modules
│   │   ├── models.ts             # isFreeModel, isKiloFreeModel, isDeadFreeModel, etc.
│   │   ├── llm-proxy-helpers.ts  # Error responses, token estimation, fraud headers, org restrictions
│   │   ├── tool-calling.ts       # repairTools (Web Crypto hash)
│   │   ├── rewrite-response.ts   # rewriteFreeModelResponse (standard Response)
│   │   ├── custom-llm.ts         # customLlmRequest via Vercel AI SDK
│   │   ├── abuse-service.ts      # classifyAbuse (fetch-based, portable)
│   │   ├── process-usage.ts      # Usage tracking (waitUntil)
│   │   ├── rate-limiter.ts       # Free model rate limiting
│   │   ├── anonymous.ts          # Anonymous user context
│   │   ├── provider-hash.ts      # generateProviderSpecificHash (Web Crypto HMAC)
│   │   └── o11y/
│   │       └── api-metrics.ts    # Metrics emission via fetch to O11Y service
│   └── middleware/
│       └── sentry.ts             # @sentry/cloudflare integration
└── test/
    └── *.test.ts                 # Vitest with @cloudflare/vitest-pool-workers
```

## Performance Design (Hot Path)

This is the hottest path in the system — every design decision prioritizes latency.

### Minimize Blocking DB Round-Trips

1. **Auth** (user lookup + pepper check) — Cache in KV with 60s TTL. Pepper rotation is rare; 60s staleness is acceptable.
2. **Balance check** — Always hits DB via Hyperdrive. No caching — balance must be accurate since it gates paid model access.
3. **Free model rate limiting** — Use KV atomic counters or Durable Objects instead of Postgres queries per request. The current `free_model_usage` table queries are expensive.
4. **Provider routing** (BYOK lookup, custom LLM lookup) — Less frequent paths but benefit from short KV caching.

### Parallelize Where Possible

- Auth + body parsing can happen in parallel
- Once auth completes: balance check + provider routing + abuse classification can run concurrently

### All Background Work via `ctx.waitUntil()`

- `countAndStoreUsage` (DB writes, OpenRouter generation fetch, org usage, PostHog)
- `sendApiMetrics` (HTTP to O11Y service)
- `handleRequestLogging` (DB write — Kilo employees only)
- `reportAbuseCost` (HTTP to abuse service)

### Near-Zero Cold Starts

CF Workers have near-zero cold starts vs Vercel serverless functions. The streaming response starts immediately after the upstream LLM responds.

## Key Adaptations

### Auth → jose + Hyperdrive (reuse KiloClaw pattern)

Source: `src/lib/user.server.ts` (`getUserFromAuth`), `kiloclaw/src/auth/jwt.ts`

- `jose` for JWT verification (Web Crypto, no Node.js `crypto` dependency)
- Verify HS256 with `NEXTAUTH_SECRET` from CF Secrets Store
- Pepper check against DB (with KV caching for user lookups)
- Anonymous fallback for free models (same logic, no NextAuth dependency needed)
- Extract `organizationId`, `botId`, `tokenSource` from JWT payload
- No NextAuth session support — only API clients (extensions) call the gateway

### Database → `@kilocode/db/client` + Hyperdrive

Source: `packages/db/src/client.ts` (`getWorkerDb`)

- `getWorkerDb(env.HYPERDRIVE.connectionString)` with `max: 1`
- Same shared `@kilocode/db/schema` — zero schema changes
- Same Hyperdrive instance ID as other workers (`624ec80650dd414199349f4e217ddb10`)

### Background Tasks → `ctx.waitUntil()`

Source: Next.js `after()` calls in `src/lib/llm-proxy-helpers.ts`, `src/lib/handleRequestLogging.ts`, `src/lib/o11y/api-metrics.server.ts`

- Direct replacement for Next.js `after()`
- Same semantics: code runs after response is sent, Worker stays alive until completion

### Crypto → Web Crypto API

Source: `src/lib/providerHash.ts`, `src/lib/tool-calling.ts`

- `crypto.randomUUID()` — available natively in Workers
- `crypto.hash('sha256', ...)` → `crypto.subtle.digest('SHA-256', ...)`
- `crypto.createHmac(...)` → `crypto.subtle.importKey() + crypto.subtle.sign()`
- `nodejs_compat` flag provides fallback for any edge cases

### Observability → `@sentry/cloudflare`

Source: `@sentry/nextjs` usage throughout `src/lib/`

- Replace `@sentry/nextjs` with `@sentry/cloudflare`
- `captureException`, `setTag`, spans all have direct equivalents
- Hono Sentry middleware for automatic request instrumentation

### Response Handling → Standard `Response`

Source: `NextResponse` usage in all route handlers

- `NextResponse.json(...)` → `Response.json(...)`
- `new NextResponse(stream)` → `new Response(stream)`
- `eventsource-parser` for SSE rewriting — pure JS, Workers-native

### Custom LLM → Vercel AI SDK (portable)

Source: `src/lib/custom-llm/customLlmRequest.ts`

- `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai` all support edge/Worker runtimes
- `streamText()` / `generateText()` work unchanged
- Only swap `NextResponse` → `Response` and `crypto.hash` → Web Crypto

### GET Metadata Routes

Source: `src/app/api/openrouter/models/route.ts`, `providers/route.ts`, `models-by-provider/route.ts`, `src/app/api/models/stats/route.ts`, `src/app/api/modelstats/route.ts`, `src/app/api/models/up/route.ts`, `src/app/api/defaults/route.ts`

- Simple DB queries via Hyperdrive
- Caching strategy: Use `Cache-Control` headers + CF Cache API (replaces `unstable_cache` and `revalidate`)
- `/api/openrouter/providers` — fetch from OpenRouter, cache via CF Cache API (24h)
- `/api/modelstats` — CORS headers set on `Response` directly

## Wrangler Configuration

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "llm-gateway",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "account_id": "e115e769bcdd4c3d66af59d3332cb394",
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "624ec80650dd414199349f4e217ddb10",
      "localConnectionString": "postgres://postgres:postgres@localhost:5432/postgres",
    },
  ],
  "kv_namespaces": [
    {
      "binding": "KV_GATEWAY_CACHE",
      "id": "<to-be-created>",
    },
  ],
  // Secrets via wrangler secret put:
  // NEXTAUTH_SECRET, OPENROUTER_API_KEY, SENTRY_DSN,
  // O11Y_SERVICE_URL, O11Y_KILO_GATEWAY_CLIENT_SECRET,
  // ABUSE_SERVICE_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET,
  // HEALTH_CHECK_KEY
}
```

## Migration Strategy

### Step 1: Build & Deploy the Worker

Create `cloudflare-llm-gateway/` workspace package. Port all routes. Deploy to `gateway.kilo.ai`.

### Step 2: Redirect Traffic

Update `next.config.mjs` on the regional app (`kilocode-app`) to issue 307 redirects:

```js
async redirects() {
  const gatewayRedirects = process.env.KILO_GATEWAY_BACKEND !== 'true'
    ? [
        { source: '/api/openrouter/:path*', destination: 'https://gateway.kilo.ai/api/openrouter/:path*', permanent: false },
        { source: '/api/gateway/:path*', destination: 'https://gateway.kilo.ai/api/gateway/:path*', permanent: false },
        { source: '/api/models/:path*', destination: 'https://gateway.kilo.ai/api/models/:path*', permanent: false },
        { source: '/api/modelstats', destination: 'https://gateway.kilo.ai/api/modelstats', permanent: false },
        { source: '/api/defaults', destination: 'https://gateway.kilo.ai/api/defaults', permanent: false },
      ]
    : [];
  return gatewayRedirects;
}
```

Clients hit `api.kilo.ai` → get 307 → follow to `gateway.kilo.ai`. No client-side changes needed for existing extension versions.

### Step 3: Update Extension (future)

Point new extension versions directly at `gateway.kilo.ai` to eliminate the redirect hop.

### Step 4: Clean Up

Remove the `kilocode-gateway` Vercel project and its deploy job. Remove old Next.js route handlers.

## CI/CD

1. Add `cloudflare-llm-gateway` to `pnpm-workspace.yaml`
2. Add `deploy-llm-gateway.yml`:
   - Path filter: `cloudflare-llm-gateway/**`, `packages/db/**`
   - `pnpm install --frozen-lockfile`
   - `cloudflare/wrangler-action@v3` with `deploy`
3. Add to `deploy-production.yml` parallel deployment jobs

## Secrets (CF Secrets Store / `wrangler secret`)

- `NEXTAUTH_SECRET` — JWT verification
- `OPENROUTER_API_KEY` — OpenRouter API
- `SENTRY_DSN` — Error tracking
- `O11Y_SERVICE_URL` + `O11Y_KILO_GATEWAY_CLIENT_SECRET` — Metrics
- `ABUSE_SERVICE_URL` + `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` — Abuse classification
- `HEALTH_CHECK_KEY` — Model health endpoint auth

## Risks & Mitigations

| Risk                                      | Mitigation                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| Vercel AI SDK edge cases in Workers       | Test `streamText`/`generateText` with both Anthropic + OpenAI providers early  |
| DB latency via Hyperdrive                 | Hyperdrive caches connections + provides pooling; KV caching for auth lookups  |
| Usage tracking accuracy during migration  | Compare usage numbers between Vercel and Worker during parallel running period |
| Extension redirect compatibility          | 307 preserves POST method and body; test with older extension versions         |
| `node:crypto` compat with `nodejs_compat` | Web Crypto is the primary path; `nodejs_compat` is fallback only               |

## Implementation Order

1. Scaffold (`wrangler.jsonc`, `package.json`, `tsconfig.json`, Hono entrypoint)
2. Auth middleware (JWT + pepper + anonymous)
3. GET metadata routes (simple DB reads — quick wins for testing Worker infrastructure)
4. Provider routing (`getProvider`, `applyProviderSpecificLogic`, `openRouterRequest`)
5. Core chat completions handler (body parsing, validation, rate limiting, balance checks, org restrictions)
6. Custom LLM (`customLlmRequest` with AI SDK)
7. Response processing (`rewriteFreeModelResponse`, `makeErrorReadable`)
8. Background tasks (`waitUntil` — usage tracking, metrics, logging)
9. Abuse service integration
10. Tool repair (`repairTools`)
11. KV caching layer (auth, rate limiting)
12. Tests
13. CI/CD workflow + secrets + deploy
14. Vercel redirect configuration
