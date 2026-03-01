/**
 * AgentDO — Per-agent event storage.
 *
 * One instance per agent (keyed by agentId). Owns the high-volume
 * agent_events table, isolating it from the Town DO's 10GB budget.
 * The Town DO writes events here as they flow through; clients query
 * here for backfill when joining a stream late.
 */

import { DurableObject } from 'cloudflare:workers';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { gt, asc, sql } from 'drizzle-orm';
import migrations from '../../drizzle/migrations';
import { rig_agent_events, type RigAgentEventsSelect } from '../db/sqlite-schema';

const AGENT_DO_LOG = '[Agent.do]';

type RigAgentEvent = Omit<RigAgentEventsSelect, 'data'> & { data: Record<string, unknown> };

function parseRigAgentEvent(row: RigAgentEventsSelect): RigAgentEvent {
  return { ...row, data: JSON.parse(row.data) as Record<string, unknown> };
}

export class AgentDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations);
    });
  }

  /**
   * Append an event. Returns the auto-incremented event ID.
   */
  async appendEvent(eventType: string, data: unknown): Promise<number> {
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data ?? {});
    const timestamp = new Date().toISOString();

    const row = this.db
      .insert(rig_agent_events)
      .values({
        agent_id: this.ctx.id.name ?? '',
        event_type: eventType,
        data: dataStr,
        created_at: timestamp,
      })
      .returning({ id: rig_agent_events.id })
      .get();

    const insertedId = row?.id ?? 0;

    // Prune old events if count exceeds 10000.
    // NOT IN subquery can't be expressed via drizzle's query builder;
    // sql template tag still provides column-safe escaping.
    this.db.run(sql`
      DELETE FROM ${rig_agent_events}
      WHERE ${rig_agent_events.id} NOT IN (
        SELECT ${rig_agent_events.id} FROM ${rig_agent_events}
        ORDER BY ${rig_agent_events.id} DESC
        LIMIT 10000
      )
    `);

    return insertedId;
  }

  /**
   * Query events for backfill. Returns events with id > afterId, up to limit.
   */
  async getEvents(afterId = 0, limit = 500): Promise<RigAgentEvent[]> {
    const rows = this.db
      .select()
      .from(rig_agent_events)
      .where(gt(rig_agent_events.id, afterId))
      .orderBy(asc(rig_agent_events.id))
      .limit(limit)
      .all();

    return rows.map(parseRigAgentEvent);
  }

  /**
   * Delete all events. Called when the agent is deleted from the Town DO.
   */
  async destroy(): Promise<void> {
    console.log(`${AGENT_DO_LOG} destroy: clearing all storage`);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async ping(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

export function getAgentDOStub(env: Env, agentId: string) {
  return env.AGENT.get(env.AGENT.idFromName(agentId));
}
