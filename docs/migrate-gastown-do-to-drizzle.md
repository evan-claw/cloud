# Migrate `cloudflare-gastown` DO SQLite to Drizzle ORM

## Prerequisites

This migration depends on PR #684 (`chore/migrate-do-sqlite-to-drizzle`), which establishes the pattern, adds `drizzle-orm` and `drizzle-kit` to the pnpm catalog, and ships the workflow docs (`docs/do-sqlite-drizzle.md`).

### Worktree setup

Work in a git worktree to avoid disrupting the main checkout:

```bash
# From the repo root
git fetch origin
git worktree add ../cloud-gastown-drizzle origin/chore/migrate-do-sqlite-to-drizzle
cd ../cloud-gastown-drizzle
git checkout -b chore/gastown-drizzle
pnpm install
```

All file paths below are relative to `cloudflare-gastown/`.

---

## Scope

| DO              | Active tables                                                                                                                          | Query call sites                              | Effort |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------ |
| `TownDO`        | 8 (`beads`, `bead_events`, `bead_dependencies`, `agent_metadata`, `review_metadata`, `escalation_metadata`, `convoy_metadata`, `rigs`) | ~68                                           | Large  |
| `GastownUserDO` | 2 (`user_towns`, `user_rigs`)                                                                                                          | ~11                                           | Small  |
| `AgentDO`       | 1 (`rig_agent_events`)                                                                                                                 | ~6                                            | Small  |
| **Total**       | **11**                                                                                                                                 | **~110** (109 `query()` + 1 raw `sql.exec()`) |        |

Complex patterns present: `INNER JOIN` (6+), `ON CONFLICT` upsert (1), subqueries (2), `COUNT` aggregates (3), `LIMIT/OFFSET` pagination.

---

## Phase 1: Schema & config

### 1.1 Add dependencies

In `package.json`:

```json
{
  "dependencies": {
    "drizzle-orm": "catalog:"
  },
  "devDependencies": {
    "drizzle-kit": "catalog:"
  }
}
```

Run `pnpm install` from the worktree root.

### 1.2 Create `drizzle.config.ts`

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/sqlite-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
```

### 1.3 Create `src/db/sqlite-schema.ts`

Define all 11 active tables in a single file using `sqliteTable` from `drizzle-orm/sqlite-core`. Each DO imports only its own tables.

Tables to define (follow column names, types, and constraints exactly as in the current `src/db/tables/*.table.ts` and `dos/town/rigs.ts`):

**TownDO tables (8):**

| Table                 | Source file                              | Notes                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beads`               | `db/tables/beads.table.ts`               | 15 columns, 4 indexes, CHECK on `type`/`status`/`priority`                                                                                                                                                              |
| `bead_events`         | `db/tables/bead-events.table.ts`         | 7 columns, 3 indexes, CHECK on `event_type`                                                                                                                                                                             |
| `bead_dependencies`   | `db/tables/bead-dependencies.table.ts`   | 3 columns, unique composite index + 1 index, CHECK on `dependency_type`. No explicit PK in current DDL -- use the unique index on `(bead_id, depends_on_bead_id)` as a composite PK or keep as-is with the unique index |
| `agent_metadata`      | `db/tables/agent-metadata.table.ts`      | 9 columns, CHECK on `role`/`status`                                                                                                                                                                                     |
| `review_metadata`     | `db/tables/review-metadata.table.ts`     | 6 columns                                                                                                                                                                                                               |
| `escalation_metadata` | `db/tables/escalation-metadata.table.ts` | 6 columns, CHECK on `severity`                                                                                                                                                                                          |
| `convoy_metadata`     | `db/tables/convoy-metadata.table.ts`     | 4 columns                                                                                                                                                                                                               |
| `rigs`                | `dos/town/rigs.ts` (inline DDL)          | 6 columns, unique index on `name`                                                                                                                                                                                       |

**GastownUserDO tables (2):**

| Table        | Source file                     |
| ------------ | ------------------------------- |
| `user_towns` | `db/tables/user-towns.table.ts` |
| `user_rigs`  | `db/tables/user-rigs.table.ts`  |

**AgentDO tables (1):**

| Table              | Source file                           | Notes                                                  |
| ------------------ | ------------------------------------- | ------------------------------------------------------ |
| `rig_agent_events` | `db/tables/rig-agent-events.table.ts` | `id` is `integer PRIMARY KEY AUTOINCREMENT`, 2 indexes |

Export `$inferInsert` and `$inferSelect` types for each table. These replace the current Zod `*Record` types.

Use `text({ enum: [...] })` + `check()` constraints to mirror the existing `CHECK` constraints. Use `sql` from `drizzle-orm` for default expressions.

### 1.4 Add `.sql` import rule to `wrangler.jsonc`

Add to the top-level config (and the `env.dev` section if it overrides `rules`):

```jsonc
"rules": [
  {
    "type": "Text",
    "globs": ["**/*.sql"],
    "fallthrough": true
  }
],
```

This enables the wrangler bundler to import `.sql` files used by the drizzle migration bundle.

### 1.5 Generate migrations

```bash
cd cloudflare-gastown
pnpm drizzle-kit generate
```

This creates:

- `drizzle/0000_*.sql` -- DDL with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
- `drizzle/meta/_journal.json`
- `drizzle/meta/0000_snapshot.json`
- `drizzle/migrations.js` + `drizzle/migrations.d.ts`

**Verify** the generated SQL matches the current DDL exactly. Compare against the `getCreateTableQueryFromTable()` output in each table file. Fix any mismatches in the schema and re-generate.

**Important:** The generated migration must use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` (not bare `CREATE TABLE`). If drizzle-kit generates bare statements, manually add `IF NOT EXISTS` to the generated SQL, matching what was done in PR #684.

---

## Phase 2: Wire up drizzle in DO constructors

For each DO, replace the initialization pattern.

### 2.1 TownDO (`src/dos/Town.do.ts`)

**Before:**

```ts
private sql: SqlStorage;
// in constructor:
this.sql = ctx.storage.sql;
void this.ctx.blockConcurrencyWhile(async () => {
  await this.initializeDatabase();
});
// initializeDatabase calls beadOps.initBeadTables, agents.initAgentTables, etc.
```

**After:**

```ts
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';

private db: DrizzleSqliteDODatabase;

// in constructor:
this.db = drizzle(ctx.storage, { logger: false });
void this.ctx.blockConcurrencyWhile(async () => {
  migrate(this.db, migrations);
});
```

Remove `initializeDatabase()` and all `init*Tables()` calls: `beadOps.initBeadTables`, `agents.initAgentTables`, `mail.initMailTables`, `reviewQueue.initReviewQueueTables`, `rigs.initRigTables`. All DDL is now handled by the drizzle migrator.

Sub-module files (`dos/town/beads.ts`, `dos/town/agents.ts`, `dos/town/rigs.ts`, `dos/town/mail.ts`, `dos/town/review-queue.ts`) that accept `sql: SqlStorage` must be updated to accept `db: DrizzleSqliteDODatabase` instead.

### 2.2 GastownUserDO (`src/dos/GastownUser.do.ts`)

Same pattern: replace `this.sql = ctx.storage.sql` + `initializeDatabase()` with `drizzle()` + `migrate()`.

### 2.3 AgentDO (`src/dos/Agent.do.ts`)

Same pattern. Note the single raw `sql.exec()` call for `SELECT last_insert_rowid()` -- replace with `.returning()` on the insert, e.g.:

```ts
const row = this.db.insert(rigAgentEvents).values({ ... }).returning({ id: rigAgentEvents.id }).get();
```

---

## Phase 3: Rewrite queries

Convert all ~110 `query()` calls and the 1 raw `sql.exec()` call to drizzle query builder. Use:

- `.get()` for single-row results
- `.all()` for multi-row results
- `.run()` for statements where you don't need the result
- `eq()`, `and()`, `or()`, `inArray()`, `gt()`, `lt()` etc. from `drizzle-orm` for WHERE conditions
- `.innerJoin(table, condition)` for joins
- `sql` template literal from `drizzle-orm` for any patterns drizzle doesn't natively support

### 3.1 TownDO main file (`src/dos/Town.do.ts` -- ~27 calls)

Operations: SELECT(11), INSERT(5), UPDATE(8), COUNT(3).

Key patterns:

- **INNER JOIN** -- 3 join constants (`CONVOY_JOIN`, `ESCALATION_JOIN`, inline `agent_metadata` join). Replace with `.innerJoin(table, eq(a.col, b.col))`.
- **COUNT** -- `SELECT COUNT(*)` becomes `db.select({ count: count() }).from(table).where(...).get()`.
- **Conditional WHERE** -- build conditions with `and()`, `or()`, `eq()`, `inArray()`.

### 3.2 Beads sub-module (`src/dos/town/beads.ts` -- ~25 calls)

Remove `initBeadTables()` entirely (was ~7 CREATE TABLE + index loops). Convert remaining ~18 queries: INSERT(2), SELECT(4), UPDATE(2), DELETE(7).

- **LIMIT/OFFSET pagination** -- `.limit(n).offset(m)`

### 3.3 Review queue (`src/dos/town/review-queue.ts` -- ~16 calls)

INSERT(6), UPDATE(7), SELECT(2). Uses `REVIEW_JOIN` constant for joining `review_metadata` on `beads`. Replace with `.innerJoin()`.

### 3.4 Agents sub-module (`src/dos/town/agents.ts` -- ~15 calls)

INSERT(2), UPDATE(7), SELECT(4). Uses `AGENT_JOIN` constant. Has subquery for agent title lookup -- use drizzle subquery or `sql` template.

### 3.5 GastownUserDO (`src/dos/GastownUser.do.ts` -- ~11 calls)

Remove 2 CREATE TABLE calls. Convert: INSERT(2), SELECT(4), DELETE(3). Simple CRUD with `ORDER BY DESC`.

### 3.6 Rigs sub-module (`src/dos/town/rigs.ts` -- ~6 calls)

Remove 1 CREATE TABLE + 1 CREATE INDEX. Convert: INSERT with `ON CONFLICT` becomes `.onConflictDoUpdate()`, SELECT(2), DELETE(1).

### 3.7 AgentDO (`src/dos/Agent.do.ts` -- ~6 calls)

Remove 1 CREATE TABLE + index loop. Convert: INSERT(1), SELECT(2), DELETE(1 with `NOT IN` subquery).

The `NOT IN (SELECT id ... ORDER BY id DESC LIMIT 10000)` prune query: use `sql` template literal for the subquery, or restructure as a drizzle subquery.

### 3.8 Mail sub-module (`src/dos/town/mail.ts` -- ~4 calls)

INSERT(1), SELECT(2), UPDATE(1). Has INNER JOIN for mail->agent_metadata.

---

## Phase 4: Cleanup

### 4.1 Delete files

| File/directory                               | Reason                            |
| -------------------------------------------- | --------------------------------- |
| `src/util/table.ts`                          | Replaced by drizzle schema        |
| `src/util/query.util.ts`                     | Replaced by drizzle query builder |
| `src/db/tables/beads.table.ts`               | Replaced by `sqlite-schema.ts`    |
| `src/db/tables/bead-events.table.ts`         | "                                 |
| `src/db/tables/bead-dependencies.table.ts`   | "                                 |
| `src/db/tables/agent-metadata.table.ts`      | "                                 |
| `src/db/tables/review-metadata.table.ts`     | "                                 |
| `src/db/tables/escalation-metadata.table.ts` | "                                 |
| `src/db/tables/convoy-metadata.table.ts`     | "                                 |
| `src/db/tables/rig-agent-events.table.ts`    | "                                 |
| `src/db/tables/user-towns.table.ts`          | "                                 |
| `src/db/tables/user-rigs.table.ts`           | "                                 |
| `src/db/tables/rig-agents.table.ts`          | Legacy, unused                    |
| `src/db/tables/rig-beads.table.ts`           | Legacy, unused                    |
| `src/db/tables/rig-mail.table.ts`            | Legacy, unused                    |
| `src/db/tables/rig-molecules.table.ts`       | Legacy, unused                    |
| `src/db/tables/rig-review-queue.table.ts`    | Legacy, unused                    |
| `src/db/tables/town-convoys.table.ts`        | Legacy, unused                    |
| `src/db/tables/town-convoy-beads.table.ts`   | Legacy, unused                    |
| `src/db/tables/town-escalations.table.ts`    | Legacy, unused                    |

After deletion, remove the `src/db/tables/` directory entirely (and any barrel `index.ts` in it).

### 4.2 Update AGENTS.md

The "SQL queries" section references `query()` helper, `/* sql */` prefixes, table interpolator objects, and Zod record parsing. Replace with:

- Use drizzle query builder (`db.select()`, `db.insert()`, `db.update()`, `db.delete()`) instead of raw SQL
- Import table objects from `src/db/sqlite-schema.ts`
- Use `$inferSelect` / `$inferInsert` types instead of Zod schemas for DB result types
- Reference `docs/do-sqlite-drizzle.md` for the migration workflow

### 4.3 Update `docs/do-sqlite-drizzle.md`

Add `cloudflare-gastown` to the "Workers using this pattern" table.

### 4.4 Check `zod` dependency

Verify whether `zod` is still imported anywhere in the worker after removing the table files and query result parsing. It is likely still needed for HTTP request body validation in handlers, but confirm before keeping it.

---

## Phase 5: Verify

1. **Typecheck**: `pnpm typecheck` from the worktree root -- must pass with no new errors in `cloudflare-gastown`.
2. **Worker typecheck**: `cd cloudflare-gastown && pnpm tsc --noEmit`.
3. **Integration tests**: `cd cloudflare-gastown && pnpm test` -- run existing test suite.
4. **Manual review of generated migration SQL**: Spot-check `drizzle/0000_*.sql` against the old DDL:
   - All CHECK constraints are present
   - All indexes match (names and columns)
   - Column defaults match exactly
   - `AUTOINCREMENT` is present on `rig_agent_events.id`
   - All `IF NOT EXISTS` markers are present

---

## Backward compatibility

The generated migration SQL uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so existing DO instances (which already have the tables but lack `__drizzle_migrations`) will not fail when drizzle runs the initial migration.

---

## Reference

- **PR #684** -- prior art for all other workers: https://github.com/Kilo-Org/cloud/pull/684
- **Migration workflow docs** -- `docs/do-sqlite-drizzle.md` (on the PR branch)
- **Example migrated worker** -- `cloudflare-ai-attribution/` on `chore/migrate-do-sqlite-to-drizzle` branch (3 tables, ~25 queries, INNER JOIN + RETURNING patterns)
