# Plan: Extract Drizzle into `packages/db`

## Goal

Move all Drizzle ORM infrastructure (schema, client creation, migrations, config) into a shared `packages/db` workspace package. Every consumer — the Next.js app and all Cloudflare workers — imports from `@kilocode/db` instead of maintaining duplicate table definitions.

**Two phases:**

1. **Phase 1** — Create `packages/db`, move files, update the Next.js app (~250 import sites).
2. **Phase 2** — Migrate the 5 Cloudflare workers from raw SQL / Kysely to the shared drizzle package.

---

## What moves into `packages/db`

| Current location                 | New location in `packages/db/src/` | Notes                                       |
| -------------------------------- | ---------------------------------- | ------------------------------------------- |
| `src/db/schema.ts`               | `schema.ts`                        | The ~3100-line authoritative schema         |
| `src/db/orb-generated/schema.ts` | `orb-generated/schema.ts`          | Orb billing tables                          |
| `src/lib/database-url.ts`        | `database-url.ts`                  | URL computation + `getDatabaseClientConfig` |
| `src/lib/drizzle.ts`             | `client.ts`                        | Refactored — see below                      |
| `src/db/migrations/`             | `migrations/`                      | All 35 SQL files + meta/                    |
| `src/db/schema.test.ts`          | `schema.test.ts`                   | Schema drift guard                          |
| `drizzle.config.ts`              | `drizzle.config.ts`                | Moved into the package                      |

### What stays in the Next.js app

- `src/lib/dotenvx.ts` — trivial env helper, not DB-specific
- `src/scripts/lib/local-database.ts` — script-specific local DB, will import from `@kilocode/db` instead

---

## Phase 1: Create package + update Next.js app

### Step 1: Create `packages/db` package

**`packages/db/package.json`:**

```json
{
  "name": "@kilocode/db",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema.ts",
    "./orb-schema": "./src/orb-generated/schema.ts",
    "./client": "./src/client.ts"
  },
  "dependencies": {
    "drizzle-orm": "^0.44.7",
    "pg": "^8.16.3"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.8",
    "@types/pg": "^8.11.0",
    "typescript": "^5.0.0"
  },
  "peerDependencies": {}
}
```

**`packages/db/tsconfig.json`:** Standalone TS config for the package.

**`packages/db/src/index.ts`:** Barrel export:

```ts
export * from './schema';
export { createDrizzleClient, type CreateDrizzleClientOptions } from './client';
export { computeDatabaseUrl, getDatabaseClientConfig } from './database-url';
export { sql } from 'drizzle-orm';
```

Add `'packages/db'` to `pnpm-workspace.yaml`.

### Step 2: Refactor `drizzle.ts` into a configurable `client.ts`

Current `src/lib/drizzle.ts` is tightly coupled to the Next.js app (Vercel region detection, `attachDatabasePool`, pool observability, `IS_SCRIPT`, etc.). The shared package should offer a **low-level factory** while the Next.js app keeps its Vercel-specific wiring.

**`packages/db/src/client.ts`** — the shared factory:

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import pg, { types } from 'pg';
import * as schema from './schema';
import { getDatabaseClientConfig } from './database-url';

// Drizzle requires this for BigInts
types.setTypeParser(types.builtins.INT8, val => BigInt(val));

export type CreateDrizzleClientOptions = {
  connectionString: string;
  poolConfig?: Partial<pg.PoolConfig>; // max, idleTimeoutMillis, connectionTimeoutMillis, application_name, etc.
  logger?: boolean;
  ssl?: { ca: string } | false;
};

export type DrizzleClient = ReturnType<typeof createDrizzleClient>;

export function createDrizzleClient(options: CreateDrizzleClientOptions) {
  const { connectionString, poolConfig = {}, logger = false, ssl } = options;

  const baseConfig = getDatabaseClientConfig(connectionString);
  if (ssl !== undefined) {
    baseConfig.ssl = ssl;
  }

  const pool = new pg.Pool({
    ...baseConfig,
    ...poolConfig,
  });

  const db = drizzle(pool, { schema, logger });

  return { db, pool, schema };
}

export { pg };
```

**`src/lib/drizzle.ts`** in the Next.js app becomes a thin wrapper:

```ts
import { createDrizzleClient, sql } from '@kilocode/db'
import { attachDatabasePool } from '@vercel/functions'
// ... all the Vercel-specific env reading, region detection, observability, etc.
// calls createDrizzleClient({ connectionString, poolConfig: { max: 10, ... }, ... })

const { db: primaryDb, pool } = createDrizzleClient({ ... })
const { db: readDb } = createDrizzleClient({ connectionString: replicaUrl, ... })
export const db = primaryDb
export { readDb, pool, sql }
// ... rest of Vercel-specific logic stays here
```

This preserves all existing behavior while making the DB client creation reusable.

### Step 3: Move schema and migrations

1. Move `src/db/schema.ts` -> `packages/db/src/schema.ts`
2. Move `src/db/orb-generated/` -> `packages/db/src/orb-generated/`
3. Move `src/db/migrations/` -> `packages/db/src/migrations/`
4. Move `src/db/schema.test.ts` -> `packages/db/src/schema.test.ts`
5. Move `drizzle.config.ts` -> `packages/db/drizzle.config.ts`
6. Move `src/lib/database-url.ts` -> `packages/db/src/database-url.ts`
7. Update root `package.json` script: `"drizzle": "pnpm --filter @kilocode/db drizzle-kit"`

### Step 4: Update all imports in the Next.js app

~300 files need import updates. Two categories:

**A. Schema imports** (`~300 files`):

```diff
- import { kilocode_users, organizations, ... } from '@/db/schema'
+ import { kilocode_users, organizations, ... } from '@kilocode/db/schema'
```

**B. Client imports** (`~250 files`):

```diff
- import { db, readDb, sql, pool, ... } from '@/lib/drizzle'
+ import { db, readDb, sql, pool, ... } from '@/lib/drizzle'  // unchanged! wrapper stays
```

The `@/lib/drizzle.ts` wrapper **stays in the Next.js app** — it just internally uses `@kilocode/db/client`. This means the ~250 files importing `db`/`readDb`/`sql` **don't need to change** in Phase 1. Only the ~300 schema imports change.

Also update:

- `src/scripts/lib/local-database.ts` — import schema from `@kilocode/db/schema`
- `src/db/empty-database.ts` — if it references the schema
- `eslint.config.mjs` — ensure `eslint-plugin-drizzle` config still works
- `tsconfig.json` — remove `src/db/schema.ts` from includes if needed (it's now in `packages/db`)

### Step 5: Update drizzle-kit config

`packages/db/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  // dbCredentials provided via CLI or env at migration time
});
```

The root `package.json` script becomes:

```json
"drizzle": "pnpm --filter @kilocode/db drizzle-kit"
```

### Step 6: Update root dependencies

- Remove `drizzle-orm` and `drizzle-kit` from root `package.json` (they live in `packages/db` now)
- Add `"@kilocode/db": "workspace:*"` to root `package.json` dependencies
- Keep `eslint-plugin-drizzle` in root devDependencies (it's an ESLint plugin, not a runtime dep)
- Keep `pg` types/dependency as needed by the Next.js wrapper

### Step 7: Verify

- `pnpm install` — workspace resolution
- `pnpm typecheck` — no type errors in root app
- `pnpm test` — schema.test.ts passes from its new location
- `pnpm drizzle generate` — still works from root via the delegated script
- Existing tests pass (db connections, schema drift check)

---

## Phase 2: Migrate Cloudflare workers

Each worker gets `@kilocode/db` as a workspace dependency and replaces its hand-rolled SQL with drizzle queries. Workers use `createDrizzleClient` with `poolConfig: { max: 1 }` since Hyperdrive handles connection pooling.

### Workers to migrate (in order of complexity, simplest first):

#### 1. `kiloclaw` (3 tables, simplest)

- **Current:** Raw `pg.Client` per query, hand-rolled SQL for `kilocode_users`, `kiloclaw_access_codes`, `kiloclaw_instances`
- **Change:** Add `@kilocode/db` dep. Replace `UserStore`, `AccessCodeStore`, `InstanceStore` to use drizzle query builder. Remove `src/util/table.ts` and `src/db/tables/` directory.
- **Connection:** `createDrizzleClient({ connectionString: env.HYPERDRIVE.connectionString, poolConfig: { max: 1 } })`

#### 2. `cloudflare-git-token-service` (3 tables)

- **Current:** Raw `pg.Client`, inlined `getTable`, queries `platform_integrations` + `organization_memberships` + `kilocode_users`
- **Change:** Same pattern. Replace `src/installation-lookup-service.ts` SQL with drizzle joins. Remove `src/db/tables.ts` and `src/db/database.ts`.

#### 3. `cloud-agent` (2 Postgres tables)

- **Current:** Raw `pg.Client` via `PlatformIntegrationsStore` for `platform_integrations` + `organization_memberships`. Also has Durable Object SQLite tables (those stay as-is).
- **Change:** Replace only the Postgres queries. DO SQLite tables are unrelated to the shared schema and remain unchanged.

#### 4. `cloudflare-webhook-agent-ingest` (5 Postgres tables)

- **Current:** Raw `pg.Client` for `kilocode_users`, `organizations`, `organization_memberships`, `agent_environment_profiles`, `agent_environment_profile_vars`, `agent_environment_profile_commands`. Also has DO SQLite tables (stay as-is).
- **Change:** Replace all Postgres stores with drizzle queries.

#### 5. `cloudflare-session-ingest` (2 Postgres tables, largest change)

- **Current:** **Kysely** + `pg.Pool` for `kilocode_users` and `cli_sessions_v2` (complex operations including recursive CTE deletes, upserts, etc.). Also has DO SQLite tables (stay as-is).
- **Change:** Replace Kysely with drizzle. This is the most complex migration due to the sophisticated query patterns (recursive CTEs, transactions, conditional updates). May need `db.execute(sql\`...\`)` for the recursive CTE delete.
- **Bonus:** Remove `kysely` dependency entirely from this package.

### Per-worker migration pattern:

1. Add `"@kilocode/db": "workspace:*"` to the worker's `package.json`
2. Create a `src/db/drizzle.ts` (or similar) that calls `createDrizzleClient` with Hyperdrive connection string and `max: 1`
3. Replace store files to use drizzle query builder with imported schema tables
4. Delete the duplicated `table.ts` / `getTable` utilities and local table definitions
5. Delete the duplicated Zod schemas for table shapes
6. Update any types that were hand-maintained to use drizzle's inferred types (`typeof table.$inferSelect`, etc.)
7. Add the worker to the package's tsconfig `references` if using project references
8. Test the worker (each has its own test setup)

### Workers NOT migrated (out of scope):

- `cloud-agent-next` — Uses Cloudflare DO SQLite only, no Postgres
- `cloudflare-ai-attribution` — Uses Cloudflare DO SQLite only, completely bespoke schema
- `cloudflare-db-proxy` — Generic SQLite proxy, no application-specific schema
- `cloudflare-o11y` — No database access

---

## Package structure after both phases

```
packages/
  db/
    package.json
    tsconfig.json
    drizzle.config.ts
    src/
      index.ts            # barrel exports
      schema.ts           # the authoritative ~3100-line schema
      orb-generated/
        schema.ts          # Orb billing tables
      client.ts            # createDrizzleClient factory
      database-url.ts      # URL computation helpers
      migrations/          # 35 SQL migration files + meta/
      schema.test.ts       # schema drift guard
```

## Risks and mitigations

| Risk                                                            | Mitigation                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Circular dependency: `packages/db` imports from Next.js app     | `packages/db` has zero imports from the Next.js app. `dotenvx.ts` is NOT moved — `database-url.ts` uses `process.env` directly. |
| Breaking `drizzle generate` workflow                            | Root script delegates to `pnpm --filter @kilocode/db drizzle-kit`. Verify immediately.                                          |
| Worker bundlers (wrangler/esbuild) can't resolve workspace deps | pnpm workspace protocol (`workspace:*`) + wrangler's `node_compat` should handle this. Test with `wrangler dev` per worker.     |
| Huge diff (300+ files for schema imports)                       | Purely mechanical find-and-replace. Can be scripted with `sed`/codemod. Do as a single atomic commit.                           |
| `schema.test.ts` snapshot paths change                          | Update the test to reference new migration directory relative to its new location.                                              |
| `@vercel/functions` import in old `drizzle.ts`                  | Stays in the Next.js wrapper, never moves to the package.                                                                       |

## Order of operations (implementation sequence)

### Phase 1 (this PR):

1. Create `packages/db/` directory and `package.json`
2. Move schema, migrations, database-url, schema.test into package
3. Create `client.ts` factory in the package
4. Create barrel `index.ts`
5. Move and adapt `drizzle.config.ts`
6. Add `packages/db` to `pnpm-workspace.yaml`
7. Rewrite `src/lib/drizzle.ts` as a thin wrapper over `@kilocode/db/client`
8. Update ~300 schema imports across the Next.js app (`@/db/schema` -> `@kilocode/db/schema`)
9. Update root `package.json` (deps, scripts)
10. Run `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm drizzle generate` (dry run)

### Phase 2 (follow-up PRs, one per worker or batched):

11. Migrate `kiloclaw`
12. Migrate `cloudflare-git-token-service`
13. Migrate `cloud-agent` (Postgres queries only)
14. Migrate `cloudflare-webhook-agent-ingest` (Postgres queries only)
15. Migrate `cloudflare-session-ingest` (replace Kysely)
