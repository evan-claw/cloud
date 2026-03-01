/**
 * Inter-agent mail system for the Town DO.
 *
 * After the beads-centric refactor (#441), mail messages are beads with
 * type='message'. The recipient is assignee_agent_bead_id, the sender
 * is stored in labels and metadata.
 */

import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { eq, and, asc, getTableColumns } from 'drizzle-orm';
import { beads, agent_metadata, type BeadsSelect } from '../../db/sqlite-schema';
import { logBeadEvent } from './beads';
import { getAgent } from './agents';
import type { SendMailInput, Mail } from '../../types';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function parseBead(row: BeadsSelect) {
  return {
    ...row,
    labels: JSON.parse(row.labels ?? '[]') as string[],
    metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
  };
}

export function initMailTables(_db: DrizzleSqliteDODatabase): void {
  // Mail tables are now part of the beads table (type='message').
  // Initialization happens in beads.initBeadTables().
}

export function sendMail(db: DrizzleSqliteDODatabase, input: SendMailInput): void {
  const id = generateId();
  const timestamp = now();

  const labels = JSON.stringify(['gt:message', `from:${input.from_agent_id}`]);
  const metadata = JSON.stringify({
    from_agent_id: input.from_agent_id,
    to_agent_id: input.to_agent_id,
  });

  db.insert(beads)
    .values({
      bead_id: id,
      type: 'message',
      status: 'open',
      title: input.subject,
      body: input.body,
      rig_id: null,
      parent_bead_id: null,
      assignee_agent_bead_id: input.to_agent_id,
      priority: 'medium',
      labels,
      metadata,
      created_by: input.from_agent_id,
      created_at: timestamp,
      updated_at: timestamp,
      closed_at: null,
    })
    .run();

  // Log bead event if the recipient has a hooked bead
  const recipient = getAgent(db, input.to_agent_id);
  if (recipient?.current_hook_bead_id) {
    logBeadEvent(db, {
      beadId: recipient.current_hook_bead_id,
      agentId: input.from_agent_id,
      eventType: 'mail_sent',
      metadata: { subject: input.subject, to: input.to_agent_id },
    });
  }
}

/**
 * Read and deliver undelivered mail for an agent.
 * Returns the mail items and batch-closes the message beads in a single UPDATE.
 */
export function readAndDeliverMail(db: DrizzleSqliteDODatabase, agentId: string): Mail[] {
  const rows = db
    .select()
    .from(beads)
    .where(
      and(
        eq(beads.type, 'message'),
        eq(beads.assignee_agent_bead_id, agentId),
        eq(beads.status, 'open')
      )
    )
    .orderBy(asc(beads.created_at))
    .all();

  if (rows.length === 0) return [];

  const mailBeads = rows.map(parseBead);

  const messages: Mail[] = mailBeads.map(mb => ({
    id: mb.bead_id,
    from_agent_id: String(mb.metadata?.from_agent_id ?? mb.created_by ?? ''),
    to_agent_id: agentId,
    subject: mb.title,
    body: mb.body ?? '',
    delivered: false,
    created_at: mb.created_at,
    delivered_at: null,
  }));

  // Batch-close all open message beads for this agent in a single UPDATE
  const timestamp = now();
  db.update(beads)
    .set({ status: 'closed', closed_at: timestamp, updated_at: timestamp })
    .where(
      and(
        eq(beads.type, 'message'),
        eq(beads.assignee_agent_bead_id, agentId),
        eq(beads.status, 'open')
      )
    )
    .run();

  return messages;
}

export function checkMail(db: DrizzleSqliteDODatabase, agentId: string): Mail[] {
  return readAndDeliverMail(db, agentId);
}

/**
 * Find open mail addressed to agents that are currently working.
 * Returns a map of agentId → Mail[] so the caller can push each batch
 * to the corresponding container process.
 *
 * Calling this does NOT mark mail as delivered — the caller should call
 * `readAndDeliverMail` after successfully pushing the messages.
 */
export function getPendingMailForWorkingAgents(db: DrizzleSqliteDODatabase): Map<string, Mail[]> {
  const rows = db
    .select(getTableColumns(beads))
    .from(beads)
    .innerJoin(agent_metadata, eq(beads.assignee_agent_bead_id, agent_metadata.bead_id))
    .where(
      and(eq(beads.type, 'message'), eq(beads.status, 'open'), eq(agent_metadata.status, 'working'))
    )
    .orderBy(asc(beads.created_at))
    .all();

  const grouped = new Map<string, Mail[]>();

  for (const row of rows) {
    const mb = parseBead(row);
    const recipientId = mb.assignee_agent_bead_id ?? '';
    if (!recipientId) continue;

    const m: Mail = {
      id: mb.bead_id,
      from_agent_id: String(mb.metadata?.from_agent_id ?? mb.created_by ?? ''),
      to_agent_id: recipientId,
      subject: mb.title,
      body: mb.body ?? '',
      delivered: false,
      created_at: mb.created_at,
      delivered_at: null,
    };

    const existing = grouped.get(recipientId);
    if (existing) {
      existing.push(m);
    } else {
      grouped.set(recipientId, [m]);
    }
  }

  return grouped;
}
