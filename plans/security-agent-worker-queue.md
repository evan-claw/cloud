# Plan: Move Security Alert Sync to Cloudflare Worker + Queue

## Problem

The security alert sync cron runs as a single Vercel function that sequentially processes 325+ owner configs. This:

- Runs up against the 800s `maxDuration` limit and times out
- Suffers from event loop handle leaks (TLS keep-alive sockets, PostHog client, fire-and-forget audit writes) that prevent function suspension after work completes
- Doesn't scale: each new enabled config adds ~200-400ms per repo to a serial loop
- A single config failure mid-loop can delay or block processing of subsequent configs

## Approach

Replace the monolithic Vercel cron function with a thin Vercel dispatcher + Cloudflare Queue consumer.

This matches the existing pattern used by `cloud-agent` (`cloud-agent-executions` queue), `cloud-agent-next` (`cloud-agent-next-callback-queue`), and `webhook-agent-ingest` (`webhook-delivery` queue) — all of which use the same Vercel→Cloudflare dispatch + queue consumer architecture.

```
Vercel cron (<10s)                    Cloudflare Queue Consumer
┌──────────────────────────┐          ┌─────────────────────────────────┐
│ 1. Auth check            │          │ Per message (one owner config): │
│ 2. Query enabled configs │  enqueue │  1. Generate GitHub token       │
│    from DB (Hyperdrive)  │ ───────> │  2. Fetch dependabot alerts     │
│ 3. Enqueue N messages    │          │  3. Upsert findings (Hyperdrive)│
│ 4. Return 200 + count    │          │  4. Prune stale repos           │
│                          │          │  5. Audit log                   │
│ BetterStack heartbeat    │          │  6. PostHog track               │
└──────────────────────────┘          └─────────────────────────────────┘
```

## Architecture Details

### New Cloudflare Worker: `cloudflare-security-sync/`

Following the project convention (`cloudflare-*` directories at repo root).

**Primitives used:**

- **Queue** (`security-sync-jobs`): one message per enabled owner config
- **Dead-letter queue** (`security-sync-jobs-dlq`): captures permanently failed syncs
- **Hyperdrive**: DB access for upserts, audit logging, config reads (already used by `git-token-service`, `session-ingest`, `webhook-agent-ingest`)
- **Service binding** to `git-token-service`: GitHub App installation token generation (already available as RPC entrypoint)
- **KV or secrets**: auth token for Vercel→Worker dispatch validation

**No Durable Objects needed** — each config sync is independent and stateless.

### Queue Message Schema

```typescript
type SecuritySyncMessage = {
  owner: { organizationId?: string; userId?: string };
  platformIntegrationId: string;
  installationId: string;
  repositories: string[];
  repoNameToId: Record<string, number>; // serializable version of Map
};
```

### Queue Configuration

```toml
[[queues.producers]]
queue = "security-sync-jobs"
binding = "SYNC_QUEUE"

[[queues.consumers]]
queue = "security-sync-jobs"
max_batch_size = 1           # process one owner config per invocation
max_retries = 3
dead_letter_queue = "security-sync-jobs-dlq"
max_concurrency = 10         # limit concurrent GitHub API load
retry_delay = "30s"          # back off on transient failures
```

`max_concurrency = 10` controls parallelism to stay within GitHub API rate limits. This is tunable — can increase as we add more installations.

### Vercel Cron Handler (simplified)

The existing `src/app/api/cron/sync-security-alerts/route.ts` becomes a thin dispatcher:

1. Auth check (unchanged)
2. Call `getEnabledSecurityReviewConfigs()` (unchanged — this is a DB query)
3. POST configs to the Cloudflare Worker's dispatch endpoint
4. Worker enqueues each config as a queue message
5. Return success with count of enqueued configs
6. BetterStack heartbeat (unchanged)

Total runtime: <10s regardless of config count.

### Worker Queue Consumer

Reuses the existing sync logic (extracted from `sync-service.ts`):

1. `syncAllReposForOwner()` — processes one owner's repos
2. `pruneStaleReposFromConfig()` — cleans up stale repos
3. Audit log write (awaited, bounded timeout)
4. PostHog tracking event

Each message is independent. Failures retry automatically. Permanent failures go to DLQ.

## Implementation Phases

### Phase 1: Worker scaffold + queue wiring

- Create `cloudflare-security-sync/` directory structure
- `wrangler.toml` with queue, Hyperdrive, service bindings
- Worker entrypoint: HTTP dispatch endpoint + queue consumer
- Auth middleware for Vercel→Worker dispatch calls
- Deploy empty worker to staging

### Phase 2: Extract sync logic into shared module

The core sync functions (`syncAllReposForOwner`, `syncDependabotAlertsForRepo`, `pruneStaleReposFromConfig`) currently live in `src/lib/security-agent/services/sync-service.ts` and depend on:

- `@/lib/drizzle` (DB via `pg` pool)
- `@/lib/security-agent/github/dependabot-api` (Octokit + GitHub App auth)
- `@/lib/security-agent/db/*` (finding upsert, config queries)
- `@sentry/nextjs` (error capture)

These need to be either:

- **Option A**: Extracted into a shared package that works in both Vercel (Node.js) and Cloudflare (Workers runtime) — requires abstracting DB and HTTP clients
- **Option B**: Duplicated into the worker with Cloudflare-native implementations (Hyperdrive for DB, `git-token-service` binding for auth, `fetch` for GitHub API)

**Recommendation: Option B** for phase 1. The sync logic is straightforward, and the worker already has access to Hyperdrive + git-token-service. Keeping it self-contained avoids a shared package abstraction layer. Can refactor to shared code later if needed.

### Phase 3: Wire up Vercel dispatcher

- Modify `route.ts` to POST configs to worker instead of calling `runFullSync()`
- Add `SECURITY_SYNC_WORKER_URL` and `SECURITY_SYNC_WORKER_AUTH_TOKEN` env vars
- Existing `getEnabledSecurityReviewConfigs()` stays in Vercel (it's a DB read)

### Phase 4: Observability + cutover

- Queue consumer emits structured logs (matching current log format for Axiom compatibility)
- DLQ monitoring / alerting via `o11y` worker
- BetterStack heartbeat from worker (per-config or aggregate)
- Feature flag or env var to toggle between old (Vercel direct) and new (queue) path
- Remove old sync loop once stable

## Migration Strategy

Run both paths in parallel during rollout:

1. Deploy worker + queue to staging, test with a subset of configs
2. Deploy to production behind a flag (`SECURITY_SYNC_USE_WORKER=true`)
3. Monitor for 2-3 cron cycles, compare sync counts and error rates
4. Remove old path and flag

## What This Fixes

| Current problem                       | How queue solves it                                                        |
| ------------------------------------- | -------------------------------------------------------------------------- |
| 800s timeout on sequential loop       | Each config processes in seconds independently                             |
| Handle leaks (TLS, PostHog, audit)    | Worker process lifecycle is managed by Cloudflare, no suspension semantics |
| One failure blocks subsequent configs | Queue retries per-message; other configs unaffected                        |
| No parallelism                        | `max_concurrency` enables controlled parallel processing                   |
| GitHub rate limit risk with growth    | `max_concurrency` acts as a throttle; can also add per-installation delays |

## Open Questions

- **Heartbeat strategy**: Single heartbeat from Vercel dispatcher (confirms enqueue), or per-config heartbeats from worker, or aggregate heartbeat after all queue messages drain?
- **Audit log destination**: Write directly via Hyperdrive from worker, or callback to Vercel API endpoint?
- **PostHog from worker**: Use `posthog-node` in the worker, or callback to Vercel to emit events?
- **Config query location**: Keep `getEnabledSecurityReviewConfigs()` in Vercel and pass full config in queue message, or have worker query configs itself via Hyperdrive?
