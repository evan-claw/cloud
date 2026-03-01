/**
 * Bead CRUD operations for the Town DO.
 * After the beads-centric refactor (#441), all object types are beads.
 */

import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import type { SQL } from 'drizzle-orm';
import { eq, and, or, desc, gt, sql } from 'drizzle-orm';
import {
  beads,
  bead_events,
  bead_dependencies,
  agent_metadata,
  review_metadata,
  escalation_metadata,
  convoy_metadata,
} from '../../db/sqlite-schema';
import type { BeadsSelect, BeadEventsSelect } from '../../db/sqlite-schema';
import type { CreateBeadInput, BeadFilter, Bead, BeadEventRecord, BeadStatus } from '../../types';

export type BeadEventType =
  | 'created'
  | 'assigned'
  | 'hooked'
  | 'unhooked'
  | 'status_changed'
  | 'closed'
  | 'escalated'
  | 'notification_failed'
  | 'mail_sent'
  | 'review_submitted'
  | 'review_completed'
  | 'agent_spawned'
  | 'agent_exited';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function parseBead(row: BeadsSelect): Bead {
  return {
    ...row,
    labels: JSON.parse(row.labels ?? '[]') as string[],
    metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
  };
}

function parseBeadEvent(row: BeadEventsSelect): BeadEventRecord {
  return {
    ...row,
    metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
  };
}

// ── Bead CRUD ───────────────────────────────────────────────────────

export function createBead(db: DrizzleSqliteDODatabase, input: CreateBeadInput): Bead {
  const id = generateId();
  const timestamp = now();

  db.insert(beads)
    .values({
      bead_id: id,
      type: input.type,
      status: 'open',
      title: input.title,
      body: input.body ?? null,
      rig_id: input.rig_id ?? null,
      parent_bead_id: input.parent_bead_id ?? null,
      assignee_agent_bead_id: input.assignee_agent_bead_id ?? null,
      priority: input.priority ?? 'medium',
      labels: JSON.stringify(input.labels ?? []),
      metadata: JSON.stringify(input.metadata ?? {}),
      created_by: input.created_by ?? null,
      created_at: timestamp,
      updated_at: timestamp,
      closed_at: null,
    })
    .run();

  const bead = getBead(db, id);
  if (!bead) throw new Error('Failed to create bead');

  logBeadEvent(db, {
    beadId: id,
    agentId: input.assignee_agent_bead_id ?? null,
    eventType: 'created',
    newValue: 'open',
    metadata: { type: input.type, title: input.title },
  });

  return bead;
}

export function getBead(db: DrizzleSqliteDODatabase, beadId: string): Bead | null {
  const row = db.select().from(beads).where(eq(beads.bead_id, beadId)).get();
  if (!row) return null;
  return parseBead(row);
}

export function listBeads(db: DrizzleSqliteDODatabase, filter: BeadFilter): Bead[] {
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;

  const conditions: SQL[] = [];
  if (filter.status) conditions.push(eq(beads.status, filter.status));
  if (filter.type) conditions.push(eq(beads.type, filter.type));
  if (filter.assignee_agent_bead_id)
    conditions.push(eq(beads.assignee_agent_bead_id, filter.assignee_agent_bead_id));
  if (filter.parent_bead_id) conditions.push(eq(beads.parent_bead_id, filter.parent_bead_id));
  if (filter.rig_id) conditions.push(eq(beads.rig_id, filter.rig_id));

  const rows = db
    .select()
    .from(beads)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(beads.created_at))
    .limit(limit)
    .offset(offset)
    .all();

  return rows.map(parseBead);
}

export function updateBeadStatus(
  db: DrizzleSqliteDODatabase,
  beadId: string,
  status: BeadStatus,
  agentId: string
): Bead {
  const bead = getBead(db, beadId);
  if (!bead) throw new Error(`Bead ${beadId} not found`);

  // No-op if already in the target status — avoids redundant events
  if (bead.status === status) return bead;

  const oldStatus = bead.status;
  const timestamp = now();
  const closedAt = status === 'closed' ? timestamp : bead.closed_at;

  db.update(beads)
    .set({ status, updated_at: timestamp, closed_at: closedAt })
    .where(eq(beads.bead_id, beadId))
    .run();

  logBeadEvent(db, {
    beadId,
    agentId,
    eventType: 'status_changed',
    oldValue: oldStatus,
    newValue: status,
  });

  const updated = getBead(db, beadId);
  if (!updated) throw new Error(`Bead ${beadId} not found after update`);
  return updated;
}

export function closeBead(db: DrizzleSqliteDODatabase, beadId: string, agentId: string): Bead {
  return updateBeadStatus(db, beadId, 'closed', agentId);
}

export function deleteBead(db: DrizzleSqliteDODatabase, beadId: string): void {
  // Recursively delete child beads (e.g. molecule steps) before the parent
  const children = db
    .select({ bead_id: beads.bead_id })
    .from(beads)
    .where(eq(beads.parent_bead_id, beadId))
    .all();
  for (const { bead_id } of children) {
    deleteBead(db, bead_id);
  }

  // Unhook any agent assigned to this bead
  db.update(agent_metadata)
    .set({ current_hook_bead_id: null, status: 'idle' })
    .where(eq(agent_metadata.current_hook_bead_id, beadId))
    .run();

  // Delete dependencies referencing this bead
  db.delete(bead_dependencies)
    .where(
      or(eq(bead_dependencies.bead_id, beadId), eq(bead_dependencies.depends_on_bead_id, beadId))
    )
    .run();

  // Delete events
  db.delete(bead_events).where(eq(bead_events.bead_id, beadId)).run();

  // Delete satellite metadata
  db.delete(agent_metadata).where(eq(agent_metadata.bead_id, beadId)).run();
  db.delete(review_metadata).where(eq(review_metadata.bead_id, beadId)).run();
  db.delete(escalation_metadata).where(eq(escalation_metadata.bead_id, beadId)).run();
  db.delete(convoy_metadata).where(eq(convoy_metadata.bead_id, beadId)).run();

  // Delete the bead itself
  db.delete(beads).where(eq(beads.bead_id, beadId)).run();
}

// ── Bead Events ─────────────────────────────────────────────────────

export function logBeadEvent(
  db: DrizzleSqliteDODatabase,
  params: {
    beadId: string;
    agentId: string | null;
    eventType: BeadEventType;
    oldValue?: string | null;
    newValue?: string | null;
    metadata?: Record<string, unknown>;
  }
): void {
  db.insert(bead_events)
    .values({
      bead_event_id: generateId(),
      bead_id: params.beadId,
      agent_id: params.agentId,
      event_type: params.eventType,
      old_value: params.oldValue ?? null,
      new_value: params.newValue ?? null,
      metadata: JSON.stringify(params.metadata ?? {}),
      created_at: now(),
    })
    .run();
}

export function listBeadEvents(
  db: DrizzleSqliteDODatabase,
  options: {
    beadId?: string;
    since?: string;
    limit?: number;
  }
): BeadEventRecord[] {
  const limit = options.limit ?? 100;

  const conditions: SQL[] = [];
  if (options.beadId) conditions.push(eq(bead_events.bead_id, options.beadId));
  if (options.since) conditions.push(gt(bead_events.created_at, options.since));

  const rows = db
    .select()
    .from(bead_events)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(bead_events.created_at))
    .limit(limit)
    .all();

  return rows.map(parseBeadEvent);
}
