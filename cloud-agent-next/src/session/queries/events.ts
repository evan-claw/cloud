import { count, max, eq, and, gt, gte, lte, lt, inArray, asc } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import type { StoredEvent } from '../../websocket/types.js';
import type { EventId } from '../../types/ids.js';
import { events } from '../../db/sqlite-schema.js';
import type { SQL } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InsertEventParams = {
  executionId: string;
  sessionId: string;
  streamEventType: string;
  payload: string;
  timestamp: number;
};

export type EventQueryFilters = {
  /** Exclusive: id > fromId */
  fromId?: EventId;
  /** Only return events for these execution IDs */
  executionIds?: string[];
  /** Only return events of these types */
  eventTypes?: string[];
  /** Inclusive: timestamp >= startTime */
  startTime?: number;
  /** Inclusive: timestamp <= endTime */
  endTime?: number;
  /** Maximum number of events to return */
  limit?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ITERATE_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConditions(filters: Omit<EventQueryFilters, 'limit'>): SQL[] {
  const conditions: SQL[] = [];

  if (filters.fromId !== undefined) {
    conditions.push(gt(events.id, filters.fromId));
  }
  if (filters.executionIds?.length) {
    conditions.push(inArray(events.execution_id, filters.executionIds));
  }
  if (filters.eventTypes?.length) {
    conditions.push(inArray(events.stream_event_type, filters.eventTypes));
  }
  if (filters.startTime !== undefined) {
    conditions.push(gte(events.timestamp, filters.startTime));
  }
  if (filters.endTime !== undefined) {
    conditions.push(lte(events.timestamp, filters.endTime));
  }

  return conditions;
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

export function createEventQueries(db: DrizzleSqliteDODatabase) {
  return {
    insert(params: InsertEventParams): EventId {
      const row = db
        .insert(events)
        .values({
          execution_id: params.executionId,
          session_id: params.sessionId,
          stream_event_type: params.streamEventType,
          payload: params.payload,
          timestamp: params.timestamp,
        })
        .returning({ id: events.id })
        .get();

      return row.id;
    },

    findByFilters(filters: EventQueryFilters): StoredEvent[] {
      const conditions = buildConditions(filters);
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      let query = db.select().from(events).where(where).orderBy(asc(events.id)).$dynamic();

      if (filters.limit !== undefined) {
        query = query.limit(filters.limit);
      }

      return query.all() satisfies StoredEvent[];
    },

    // Drizzle's durable-sqlite driver doesn't expose a lazy cursor, so we
    // paginate in batches to bound memory instead of loading all rows at once.
    *iterateByFilters(filters: Omit<EventQueryFilters, 'limit'>): Generator<StoredEvent> {
      let lastId: number | undefined = filters.fromId;

      for (;;) {
        const conditions = buildConditions({ ...filters, fromId: lastId });
        const where = conditions.length > 0 ? and(...conditions) : undefined;
        const batch = db
          .select()
          .from(events)
          .where(where)
          .orderBy(asc(events.id))
          .limit(ITERATE_BATCH_SIZE)
          .all();

        if (batch.length === 0) break;
        yield* batch;
        lastId = batch[batch.length - 1].id;
      }
    },

    deleteOlderThan(timestamp: number): number {
      const deleted = db
        .delete(events)
        .where(lt(events.timestamp, timestamp))
        .returning({ id: events.id })
        .all();
      return deleted.length;
    },

    countByExecutionId(executionId: string): number {
      const row = db
        .select({ count: count() })
        .from(events)
        .where(eq(events.execution_id, executionId))
        .get();

      return row?.count ?? 0;
    },

    getLatestEventId(): EventId | null {
      const row = db
        .select({ max_id: max(events.id) })
        .from(events)
        .get();
      return row?.max_id ?? null;
    },
  };
}

export type EventQueries = ReturnType<typeof createEventQueries>;
