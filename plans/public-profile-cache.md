# Public Profile: Caching Strategy for `microdollar_usage`

## Problem

The public profile feature needs aggregated per-user, per-feature usage data (request counts, token totals, daily activity heatmaps, streaks). The source data lives in `microdollar_usage` joined with `microdollar_usage_metadata` — a massive, high-write-volume table that cannot be queried directly for every profile view or even on a periodic cron without creating load problems.

This document evaluates four caching strategies and recommends one.

---

## Context: Existing Patterns

The codebase already has one write-time pre-aggregation pattern: `organization_user_usage`. On every insert into `microdollar_usage`, `ingestOrganizationTokenUsage()` upserts a daily per-user per-org cost summary via `ON CONFLICT DO UPDATE SET microdollar_usage += cost`. This avoids ever needing to re-aggregate `microdollar_usage` for org balance checks.

The `user_period_cache` table exists in the schema with shareability columns (`shared_url_token`, `shared_at`) and a JSONB `data` column, but has zero read/write application code — only the GDPR `softDeleteUser` deletes from it.

All current usage-display endpoints (`/api/profile/usage`, `user.getAutocompleteMetrics`, org usage details) query `microdollar_usage` directly with `SUM()`/`COUNT()` aggregations. These will also degrade as the table grows, independent of the public profile feature.

---

## Options Evaluated

### Option 1: Write-time upsert into a daily summary table

On every insert into `microdollar_usage`, also upsert into a new `user_feature_daily_usage` table:

```sql
INSERT INTO user_feature_daily_usage (kilo_user_id, feature_id, usage_date, request_count, total_tokens)
VALUES ($1, $2, CURRENT_DATE, 1, $3)
ON CONFLICT (kilo_user_id, feature_id, usage_date)
DO UPDATE SET
  request_count = user_feature_daily_usage.request_count + 1,
  total_tokens = user_feature_daily_usage.total_tokens + EXCLUDED.total_tokens
```

Added as a CTE in the existing `insertUsageAndMetadataWithBalanceUpdate()` in `processUsage.ts`.

**Pros:**

- Proven pattern — mirrors `organization_user_usage` in the same codebase, same write path
- Zero query cost at read time — the summary table IS the cache
- No cron needed for freshness — always up-to-date
- Tiny table: users x features x days (a heavy user with all 11 features active every day for a year = ~4,000 rows)
- Heatmap, streak, and active_days calculations become trivial queries on the small table

**Cons:**

- Adds ~1 upsert per LLM request to the hot write path (but `organization_user_usage` already does exactly this)
- Requires one-time backfill from existing data
- New table + migration

---

### Option 2: Cron-based aggregation into `user_period_cache` only

The approach from the original plan: a scheduled job queries `microdollar_usage` + `microdollar_usage_metadata` per user and writes the aggregated JSON to `user_period_cache`.

**Pros:**

- No changes to the write path
- Uses existing `user_period_cache` table as-is

**Cons:**

- Still queries `microdollar_usage` on every refresh cycle, just less often
- Incremental merge for `active_days` / `COUNT(DISTINCT date)` / streaks requires storing intermediate state (full date sets) in the JSONB — gets large for heavy users
- Cron batching N users x (aggregation query + heatmap query) creates periodic load spikes on Postgres
- The join with `microdollar_usage_metadata` is expensive — `microdollar_usage_metadata` has no index on `(id, feature_id)`
- Scales poorly: more users opting in = longer cron runs

---

### Option 3: Postgres materialized view

```sql
CREATE MATERIALIZED VIEW user_feature_daily_mv AS
SELECT
  mu.kilo_user_id,
  mum.feature_id,
  mum.created_at::date AS usage_date,
  COUNT(*) AS request_count,
  SUM(mu.input_tokens + mu.output_tokens) AS total_tokens
FROM microdollar_usage mu
JOIN microdollar_usage_metadata mum ON mum.id = mu.id
GROUP BY mu.kilo_user_id, mum.feature_id, mum.created_at::date;
```

Refreshed via `pg_cron` or Vercel cron calling `REFRESH MATERIALIZED VIEW CONCURRENTLY`.

**Pros:**

- No changes to the write path
- SQL-native, no application logic for aggregation

**Cons:**

- `REFRESH` re-reads the entire join — this IS the full table scan problem, just scheduled
- No incremental refresh in Postgres — the entire view is recomputed each time
- The materialized view itself becomes large (every user x feature x day)
- `CONCURRENTLY` requires a unique index on the view
- Tight coupling to Postgres internals — harder to reason about in application code
- Doesn't compose with `user_period_cache` for sharing URLs

---

### Option 4: Hybrid — write-time daily summary + lazy `user_period_cache` (recommended)

Combines Option 1's write-time daily summary with on-demand computation for `user_period_cache`:

1. **Write path**: Upsert into `user_feature_daily_usage` on every insert (same as Option 1)
2. **Read path**: When a public profile is requested, check `user_period_cache` for a fresh entry. If stale (>6h) or missing, recompute from `user_feature_daily_usage` (fast) and write to `user_period_cache`.
3. **No cron**: Cache is lazily populated on first access and refreshed on subsequent accesses if stale.

The lazy refresh is fast because it reads from the pre-aggregated daily summary, not from `microdollar_usage`. Computing streaks, active_days, and heatmap from a few hundred rows per user takes <10ms.

**Pros:**

- Everything from Option 1, plus:
- No cron job to manage
- Only active profiles get computed — zero wasted work for profiles nobody visits
- Cache stays warm for popular profiles
- Stale-while-revalidate possible: serve stale cache immediately, trigger async refresh
- `user_period_cache` still serves its purpose for sharing URLs and pre-rendered JSON

**Cons:**

- Same write-path cost as Option 1 (1 extra upsert per request)
- First access after staleness window has slightly higher latency to recompute from daily summary (~50-100ms)
- Same backfill requirement as Option 1

---

## Recommendation: Option 4

Option 4 is the strongest choice for this codebase:

1. **Completely eliminates querying `microdollar_usage` for public profiles.** The daily summary absorbs aggregation cost incrementally at write time, amortized across millions of requests. Reading ~4K rows per user per year from the summary table is effectively free.

2. **Follows the existing pattern.** `organization_user_usage` already proves this upsert-on-write approach works in this codebase, in this write path, with this traffic.

3. **No cron means no batch load spikes.** The cron approach concentrates N expensive queries into a burst. Lazy computation spreads load naturally with actual demand.

4. **Handles inactive users for free.** If nobody visits a profile, no work happens. No need for heuristics like "stop refreshing after N days of inactivity."

5. **The daily summary table is independently useful.** Beyond public profiles, it can replace the full-table scans in `/api/profile/usage` (which currently aggregates ALL user history from `microdollar_usage` per request) and `user.getAutocompleteMetrics`. This is infrastructure, not a profile-specific hack.

---

## Implementation Sketch

### New table: `user_feature_daily_usage`

```
user_feature_daily_usage
  kilo_user_id   text      NOT NULL
  feature_id     integer   NOT NULL  -- FK -> feature
  usage_date     date      NOT NULL
  request_count  integer   NOT NULL  DEFAULT 0
  total_tokens   bigint    NOT NULL  DEFAULT 0

  UNIQUE (kilo_user_id, feature_id, usage_date)
  INDEX  (kilo_user_id, usage_date)
```

### Write path change

Add one CTE to the existing `insertUsageAndMetadataWithBalanceUpdate()` in `processUsage.ts`:

```sql
, daily_usage_upsert AS (
  INSERT INTO user_feature_daily_usage
    (kilo_user_id, feature_id, usage_date, request_count, total_tokens)
  SELECT
    $kilo_user_id,
    (SELECT feature_id FROM feature_cte),
    CURRENT_DATE,
    1,
    $input_tokens + $output_tokens
  ON CONFLICT (kilo_user_id, feature_id, usage_date)
  DO UPDATE SET
    request_count = user_feature_daily_usage.request_count + 1,
    total_tokens  = user_feature_daily_usage.total_tokens + EXCLUDED.total_tokens
)
```

The `feature_cte` already exists in the CTE chain. Rows where `feature_id` is null (untagged usage) are excluded — the `SELECT` returns no rows if the subquery is null, so the upsert is a no-op.

### Read path

A function `computePublicProfileData(userId: string)` that:

1. Reads all `user_feature_daily_usage` rows for the user (365-day window or full history)
2. Joins with the `feature` table to get feature names
3. Computes in TypeScript: per-feature stats, heatmap, streaks, active_days, totals
4. Writes the result to `user_period_cache` with `cache_type = 'public_profile'`

The `publicProfile.get` tRPC procedure:

1. Looks up `user_period_cache` by `shared_url_token`
2. If fresh (computed_at within 6h), returns `data` directly
3. If stale or missing, calls `computePublicProfileData()`, then returns the result

### Backfill

A one-time migration script that aggregates existing `microdollar_usage` + `microdollar_usage_metadata` into `user_feature_daily_usage`. Process in date-range batches (e.g., one month at a time) to avoid long-running transactions:

```sql
INSERT INTO user_feature_daily_usage (kilo_user_id, feature_id, usage_date, request_count, total_tokens)
SELECT
  mu.kilo_user_id,
  mum.feature_id,
  mum.created_at::date,
  COUNT(*),
  SUM(mu.input_tokens + mu.output_tokens)
FROM microdollar_usage mu
JOIN microdollar_usage_metadata mum ON mum.id = mu.id
WHERE mum.feature_id IS NOT NULL
  AND mum.created_at >= $batch_start
  AND mum.created_at < $batch_end
GROUP BY mu.kilo_user_id, mum.feature_id, mum.created_at::date
ON CONFLICT (kilo_user_id, feature_id, usage_date)
DO UPDATE SET
  request_count = user_feature_daily_usage.request_count + EXCLUDED.request_count,
  total_tokens  = user_feature_daily_usage.total_tokens + EXCLUDED.total_tokens;
```

### GDPR

`user_feature_daily_usage` contains `kilo_user_id`, so `softDeleteUser` in `src/lib/user.ts` must delete from it:

```typescript
await tx.delete(user_feature_daily_usage).where(eq(user_feature_daily_usage.kilo_user_id, userId));
```

Add a corresponding test in `src/lib/user.test.ts`.

### Nullable `feature_id`

`microdollar_usage_metadata.feature_id` is nullable. Rows without a `feature_id` are excluded from the daily summary (the CTE `SELECT` returns no rows when the feature subquery is null). These are likely old records from before feature tracking was added and should not appear on public profiles.
