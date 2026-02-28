# Migrate DO SQLite Raw SQL → Drizzle ORM

Migrate all Durable Object SQLite code from raw `ctx.storage.sql.exec()` calls to Drizzle ORM using `drizzle-orm/durable-sqlite`.

## Current state

All raw SQL in workers is in Durable Object (DO) SQLite storage — not D1 or Postgres. Workers that access the central Postgres DB already use Drizzle via `@kilocode/db`. The raw SQL lives exclusively in DO code using `ctx.storage.sql.exec()`.

Three raw SQL patterns exist:

1. **Direct `sql.exec()`** — bare `SqlStorage.exec()` calls with string SQL
2. **Table interpolator pattern** — custom `getTable()`/`getTableFromZodSchema()` utility for type-safe column name interpolation into template strings
3. **Custom tagged template** — bespoke tagged template functions that build parameterized queries

The table interpolator utility (`table.ts`) is copy-pasted across 4 services.

## Out of scope

- **`cloudflare-db-proxy`** — this worker IS a SQL proxy; raw SQL is by design
- **`cloudflare-o11y` Analytics Engine queries** (`src/alerting/query.ts`) — HTTP POST calls to Cloudflare's Analytics Engine SQL API, not a database; no ORM exists for this

## Per-worker migration recipe

For each worker:

1. Add `drizzle-kit` as a devDependency (using `catalog:`)
2. Add `drizzle-orm` as a dependency if not already present (using `catalog:`)
3. Create `drizzle.config.ts` with `dialect: 'sqlite'`, pointing to the new schema file
4. Create `src/db/sqlite-schema.ts` — Drizzle schema using `sqliteTable` from `drizzle-orm/sqlite-core`
5. Generate initial migration via `drizzle-kit generate` that matches the existing DDL exactly
6. In the DO constructor, replace `this.sql = ctx.storage.sql` with a `drizzle()` call from `drizzle-orm/durable-sqlite`, and run `migrate()` inside `blockConcurrencyWhile`
7. Replace all raw queries with Drizzle query builder (`db.select()`, `db.insert()`, `db.update()`, `db.delete()`)
8. Delete the custom `table.ts` utility, Zod-based table definitions in `src/db/tables/`, and any `getCreateTableQueryFromTable` usage
9. Run `pnpm typecheck` on the worker to verify

## Phase 1 — Simple DOs

### 1a. `cloudflare-o11y` — AlertConfigDO

|         |                                     |
| ------- | ----------------------------------- |
| Tables  | `alert_config`, `ttfb_alert_config` |
| Queries | ~10                                 |
| Effort  | Small                               |

**Files to modify:**

- `cloudflare-o11y/src/alerting/AlertConfigDO.ts` — replace ~10 `ctx.storage.sql.exec()` calls

**New files:**

- `cloudflare-o11y/src/db/sqlite-schema.ts`
- `cloudflare-o11y/drizzle.config.ts`
- `cloudflare-o11y/drizzle/` — generated migration SQL

**Skip:** `src/alerting/query.ts` — Analytics Engine SQL API, not DO SQLite.

Straightforward CRUD, no JOINs, no dynamic queries.

---

### 1b. `cloudflare-session-ingest` — SessionIngestDO + SessionAccessCacheDO

|         |                                           |
| ------- | ----------------------------------------- |
| Tables  | `ingest_items`, `ingest_meta`, `sessions` |
| Queries | ~15                                       |
| Effort  | Small-medium                              |

**Files to modify:**

- `cloudflare-session-ingest/src/dos/SessionIngestDO.ts` — replace ~12 `this.sql.exec()` calls
- `cloudflare-session-ingest/src/dos/SessionAccessCacheDO.ts` — replace ~4 `this.sql.exec()` calls

**New files:**

- `cloudflare-session-ingest/src/db/sqlite-schema.ts`
- `cloudflare-session-ingest/drizzle.config.ts`
- `cloudflare-session-ingest/drizzle/`

Two separate DOs, each gets its own `drizzle()` instance. Uses `ON CONFLICT ... DO UPDATE` (upsert) — Drizzle supports this via `.onConflictDoUpdate()`. Already has `drizzle-orm` in `package.json` for Postgres; just needs `drizzle-kit`.

---

## Phase 2 — Table Interpolator Workers

### 2a. `cloudflare-ai-attribution` — AttributionTrackerDO

|         |                                                         |
| ------- | ------------------------------------------------------- |
| Tables  | `lines_added`, `lines_removed`, `attributions_metadata` |
| Queries | ~25                                                     |
| Effort  | Medium                                                  |

**Files to modify:**

- `cloudflare-ai-attribution/src/dos/AttributionTracker.do.ts` — replace ~20 `this.query()` calls

**Files to delete:**

- `cloudflare-ai-attribution/src/util/table.ts`
- `cloudflare-ai-attribution/src/db/tables/attributions_metadata.table.ts`
- `cloudflare-ai-attribution/src/db/tables/lines_added.table.ts`
- `cloudflare-ai-attribution/src/db/tables/lines_removed.table.ts`
- Any barrel `index.ts` re-exporting these

**New files:**

- `cloudflare-ai-attribution/src/db/sqlite-schema.ts`
- `cloudflare-ai-attribution/drizzle.config.ts`
- `cloudflare-ai-attribution/drizzle/`

Has `INNER JOIN` queries — use Drizzle's `.innerJoin()`. Has `RETURNING *` on INSERT — Drizzle supports `.returning()`. Needs `drizzle-orm` added to `package.json`.

---

### 2b. `cloudflare-webhook-agent-ingest` — TriggerDO

|         |                              |
| ------- | ---------------------------- |
| Tables  | `requests`, `trigger_config` |
| Queries | ~20                          |
| Effort  | Medium                       |

**Files to modify:**

- `cloudflare-webhook-agent-ingest/src/dos/TriggerDO.ts` — replace ~20 `this.query()` calls

**Files to delete:**

- `cloudflare-webhook-agent-ingest/src/util/table.ts`
- `cloudflare-webhook-agent-ingest/src/db/tables/requests.table.ts`
- `cloudflare-webhook-agent-ingest/src/db/tables/trigger-config.table.ts` (if exists)

**New files:**

- `cloudflare-webhook-agent-ingest/src/db/sqlite-schema.ts`
- `cloudflare-webhook-agent-ingest/drizzle.config.ts`
- `cloudflare-webhook-agent-ingest/drizzle/`

Has dynamic `ALTER TABLE` migration logic (TriggerDO.ts:155) — the initial Drizzle migration must produce the _final_ schema (with all added columns), since all existing DOs will already have been migrated by the hand-written ALTER logic. Already has `drizzle-orm` in `package.json`.

---

## Phase 3 — Agent Workers

### 3a. `cloud-agent` — CloudAgentSession

|         |                                               |
| ------- | --------------------------------------------- |
| Tables  | `events`, `execution_leases`, `command_queue` |
| Queries | ~25                                           |
| Effort  | Large                                         |

**Files to modify:**

- `cloud-agent/src/persistence/CloudAgentSession.ts` — replace factory function wiring
- `cloud-agent/src/persistence/migrations.ts` — delete (replaced by Drizzle migrations)
- `cloud-agent/src/session/queries/events.ts` — rewrite with Drizzle
- `cloud-agent/src/session/queries/leases.ts` — rewrite with Drizzle
- `cloud-agent/src/session/queries/command-queue.ts` — rewrite with Drizzle
- `cloud-agent/test/integration/queue/dispatcher.test.ts` — update raw SQL in test

**Files to delete:**

- `cloud-agent/src/utils/table.ts`
- `cloud-agent/src/db/tables/events.table.ts`
- `cloud-agent/src/db/tables/execution-leases.table.ts`
- `cloud-agent/src/db/tables/command-queue.table.ts`
- `cloud-agent/src/db/tables/index.ts`

**New files:**

- `cloud-agent/src/db/sqlite-schema.ts`
- `cloud-agent/drizzle.config.ts`
- `cloud-agent/drizzle/`

Most complex queries: dynamic WHERE clause construction from filters in `events.ts`. Uses `createEventQueries(sql)` factory pattern — the factory will change to accept a Drizzle DB instance instead of raw `SqlStorage`. Already has `drizzle-orm` in `package.json`.

---

### 3b. `cloud-agent-next` — CloudAgentSession

|         |                                               |
| ------- | --------------------------------------------- |
| Tables  | `events`, `execution_leases`, `command_queue` |
| Queries | ~25                                           |
| Effort  | Large                                         |

**Files to modify:**

- `cloud-agent-next/src/persistence/CloudAgentSession.ts`
- `cloud-agent-next/src/persistence/migrations.ts`
- `cloud-agent-next/src/session/queries/events.ts`
- `cloud-agent-next/src/session/queries/leases.ts`

**Files to delete:**

- `cloud-agent-next/src/db/table.ts`
- `cloud-agent-next/src/utils/table.ts` (duplicate)
- `cloud-agent-next/src/db/tables/events.table.ts`
- `cloud-agent-next/src/db/tables/execution-leases.table.ts`
- `cloud-agent-next/src/db/tables/organization-memberships.table.ts`
- `cloud-agent-next/src/db/tables/platform-integrations.table.ts`
- `cloud-agent-next/src/db/tables/index.ts`

**New files:**

- `cloud-agent-next/src/db/sqlite-schema.ts`
- `cloud-agent-next/drizzle.config.ts`
- `cloud-agent-next/drizzle/`

Nearly identical to `cloud-agent` — apply the same pattern. Has additional table definitions (`organization-memberships`, `platform-integrations`) in `src/db/tables/` that may be Postgres-related via `SqlStore` — verify before deleting. Needs `drizzle-orm` added to `package.json`.

---

## Phase 4 — App Builder

### 4. `cloudflare-app-builder` — GitRepositoryDO

|         |               |
| ------- | ------------- |
| Tables  | `git_objects` |
| Queries | ~20           |
| Effort  | Medium        |

**Files to modify:**

- `cloudflare-app-builder/src/git-repository-do.ts` — replace custom `sql` tagged template helper
- `cloudflare-app-builder/src/git/fs-adapter.ts` — replace ~20 queries on `git_objects`

**New files:**

- `cloudflare-app-builder/src/db/sqlite-schema.ts`
- `cloudflare-app-builder/drizzle.config.ts`
- `cloudflare-app-builder/drizzle/`

Uses a custom tagged template `this.sql<T>` (different pattern from table interpolators). Single table but many queries scattered across `fs-adapter.ts`. Performance-sensitive (git operations) — verify no regression. Needs `drizzle-orm` added to `package.json`.

---

## Summary

| Phase | Worker                            | Tables | Queries | Effort    | Delete `table.ts`?      |
| ----- | --------------------------------- | ------ | ------- | --------- | ----------------------- |
| 1a    | `cloudflare-o11y`                 | 2      | ~10     | Small     | N/A                     |
| 1b    | `cloudflare-session-ingest`       | 3      | ~15     | Small-Med | N/A                     |
| 2a    | `cloudflare-ai-attribution`       | 3      | ~25     | Medium    | Yes                     |
| 2b    | `cloudflare-webhook-agent-ingest` | 2      | ~20     | Medium    | Yes                     |
| 3a    | `cloud-agent`                     | 3      | ~25     | Large     | Yes                     |
| 3b    | `cloud-agent-next`                | 3      | ~25     | Large     | Yes                     |
| 4     | `cloudflare-app-builder`          | 1      | ~20     | Medium    | N/A (different pattern) |

**Total:** ~140 raw SQL queries across 8 DOs in 7 workers.
