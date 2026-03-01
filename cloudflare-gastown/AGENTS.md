# Conventions

## File naming

- Add a suffix matching the module type, e.g. `agents.table.ts`, `gastown.worker.ts`.
- Modules that predominantly export a class should be named after that class, e.g. `AgentIdentity.do.ts` for `AgentIdentityDO`.

## Durable Objects

- Each DO module must export a `get{ClassName}Stub` helper function (e.g. `getRigDOStub`) that centralizes how that DO namespace creates instances. Callers should use this helper instead of accessing the namespace binding directly.

## IO boundaries

- Always validate data at IO boundaries (HTTP responses, JSON.parse results, SSE event payloads, subprocess output) with Zod schemas. Return `unknown` from raw fetch/parse helpers and `.parse()` in the caller.
- Never use `as` to cast IO data. If the shape is known, define a Zod schema; if not, use `.passthrough()` or a catch-all schema.

## Column naming

- Never name a primary key column just `id`. Encode the entity in the column name, e.g. `bead_id`, `bead_event_id`, `rig_id`. This avoids ambiguity in joins and makes grep-based navigation reliable.

## SQL queries

- Use the Drizzle query builder (`db.select()`, `db.insert()`, `db.update()`, `db.delete()`) for all database operations. Do not use raw SQL strings.
- Import table objects from `db/sqlite-schema.ts`. Reference columns via the table object (e.g. `beads.bead_id`, `agent_metadata.status`).
- Use `$inferSelect` / `$inferInsert` types from `db/sqlite-schema.ts` for row types. Do not define ad-hoc row types or use Zod schemas for DB result parsing.
- For JSON columns stored as `text` (`labels`, `metadata`, `config`, `checkpoint`, `data`), parse with `JSON.parse()` after reading and serialize with `JSON.stringify()` before writing.
- Use `.get()` for single-row results, `.all()` for multi-row results, `.run()` for write operations.
- Use `eq()`, `and()`, `or()`, `inArray()`, `gt()`, `lt()`, `isNull()`, `isNotNull()` from `drizzle-orm` for WHERE conditions.
- Use `.innerJoin(table, condition)` for joins.
- For conditional filters, build a `conditions: SQL[]` array and pass to `and(...conditions)`.
- Reference `docs/do-sqlite-drizzle.md` for the drizzle migration workflow (schema changes, generating migrations).

## HTTP routes

- **Do not use Hono sub-app mounting** (e.g. `app.route('/prefix', subApp)`). Define all routes in the main worker entry point (e.g. `gastown.worker.ts`) so a human can scan one file and immediately see every route the app exposes.
- Move handler logic into `handlers/*.handler.ts` modules. Each module owns routes for a logical domain. Name the file after the domain, e.g. `handlers/rig-agents.handler.ts` for `/api/rigs/:rigId/agents/*` routes.
- Each handler function takes two arguments:
  1. The Hono `Context` object (typed as the app's `HonoContext` / `GastownEnv`).
  2. A plain object containing the route params parsed from the path, e.g. `{ rigId: string }` or `{ rigId: string; beadId: string }`.

  This keeps the handler's contract explicit and testable, while the route definition in the entry point is the single source of truth for path → param shape.

  ```ts
  // gastown.worker.ts — route definition
  app.post('/api/rigs/:rigId/agents', c => handleRegisterAgent(c, c.req.param()));

  // handlers/rig-agents.handler.ts — handler implementation
  export async function handleRegisterAgent(c: Context<GastownEnv>, params: { rigId: string }) {
    // Zod validation lives in the handler, not as route middleware
    const parsed = RegisterAgentBody.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { success: false, error: 'Invalid request body', issues: parsed.error.issues },
        400
      );
    }
    const rig = getRigDOStub(c.env, params.rigId);
    const agent = await rig.registerAgent(parsed.data);
    return c.json(resSuccess(agent), 201);
  }
  ```
