/**
 * Agent CRUD, hook management (GUPP), and name allocation for the Town DO.
 *
 * After the beads-centric refactor (#441), agents are beads with type='agent'
 * joined with agent_metadata for operational state.
 */

import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import type { SQL } from 'drizzle-orm';
import { eq, and, or, asc, desc, isNull, inArray, ne, getTableColumns } from 'drizzle-orm';
import { beads, agent_metadata, type BeadsSelect } from '../../db/sqlite-schema';
import { logBeadEvent, getBead, deleteBead } from './beads';
import { readAndDeliverMail } from './mail';
import type {
  RegisterAgentInput,
  AgentFilter,
  Agent,
  AgentRole,
  PrimeContext,
  Bead,
} from '../../types';

// Polecat name pool (20 names, used in allocation order)
const POLECAT_NAME_POOL = [
  'Toast',
  'Maple',
  'Birch',
  'Shadow',
  'Clover',
  'Ember',
  'Sage',
  'Dusk',
  'Flint',
  'Coral',
  'Slate',
  'Reed',
  'Thorn',
  'Pike',
  'Moss',
  'Wren',
  'Blaze',
  'Gale',
  'Drift',
  'Lark',
];

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// Agent join: select all bead columns except status (which comes from agent_metadata)
const { status: _beadStatus, ...beadColumns } = getTableColumns(beads);
const agentJoinColumns = {
  ...beadColumns,
  role: agent_metadata.role,
  identity: agent_metadata.identity,
  container_process_id: agent_metadata.container_process_id,
  status: agent_metadata.status,
  current_hook_bead_id: agent_metadata.current_hook_bead_id,
  dispatch_attempts: agent_metadata.dispatch_attempts,
  last_activity_at: agent_metadata.last_activity_at,
  checkpoint: agent_metadata.checkpoint,
};

type AgentJoinRow = {
  bead_id: string;
  type: string;
  title: string;
  body: string | null;
  rig_id: string | null;
  parent_bead_id: string | null;
  assignee_agent_bead_id: string | null;
  priority: string | null;
  labels: string | null;
  metadata: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  role: string;
  identity: string;
  container_process_id: string | null;
  status: string;
  current_hook_bead_id: string | null;
  dispatch_attempts: number;
  last_activity_at: string | null;
  checkpoint: string | null;
};

/** Map an agent join row to the Agent API type. */
function toAgent(row: AgentJoinRow): Agent {
  return {
    id: row.bead_id,
    rig_id: row.rig_id,
    role: row.role as Agent['role'],
    name: row.title,
    identity: row.identity,
    status: row.status as Agent['status'],
    current_hook_bead_id: row.current_hook_bead_id,
    dispatch_attempts: row.dispatch_attempts,
    last_activity_at: row.last_activity_at,
    checkpoint: row.checkpoint ? JSON.parse(row.checkpoint) : null,
    created_at: row.created_at,
  };
}

function agentJoinQuery(db: DrizzleSqliteDODatabase) {
  return db
    .select(agentJoinColumns)
    .from(beads)
    .innerJoin(agent_metadata, eq(beads.bead_id, agent_metadata.bead_id));
}

export function initAgentTables(_db: DrizzleSqliteDODatabase): void {
  // Agent tables are now initialized in beads.initBeadTables()
  // (beads table + agent_metadata satellite)
}

export function registerAgent(db: DrizzleSqliteDODatabase, input: RegisterAgentInput): Agent {
  const id = generateId();
  const timestamp = now();

  // Create the agent bead
  db.insert(beads)
    .values({
      bead_id: id,
      type: 'agent',
      status: 'open',
      title: input.name,
      body: null,
      rig_id: input.rig_id ?? null,
      parent_bead_id: null,
      assignee_agent_bead_id: null,
      priority: 'medium',
      labels: '[]',
      metadata: '{}',
      created_by: null,
      created_at: timestamp,
      updated_at: timestamp,
      closed_at: null,
    })
    .run();

  // Create the agent_metadata satellite row
  db.insert(agent_metadata)
    .values({
      bead_id: id,
      role: input.role,
      identity: input.identity,
      container_process_id: null,
      status: 'idle',
      current_hook_bead_id: null,
      dispatch_attempts: 0,
      checkpoint: null,
      last_activity_at: null,
    })
    .run();

  const agent = getAgent(db, id);
  if (!agent) throw new Error('Failed to create agent');
  return agent;
}

export function getAgent(db: DrizzleSqliteDODatabase, agentId: string): Agent | null {
  const row = agentJoinQuery(db).where(eq(beads.bead_id, agentId)).get();
  if (!row) return null;
  return toAgent(row as AgentJoinRow);
}

export function getAgentByIdentity(db: DrizzleSqliteDODatabase, identity: string): Agent | null {
  const row = agentJoinQuery(db).where(eq(agent_metadata.identity, identity)).get();
  if (!row) return null;
  return toAgent(row as AgentJoinRow);
}

export function listAgents(db: DrizzleSqliteDODatabase, filter?: AgentFilter): Agent[] {
  const conditions: SQL[] = [];
  if (filter?.role) conditions.push(eq(agent_metadata.role, filter.role));
  if (filter?.status) conditions.push(eq(agent_metadata.status, filter.status));
  if (filter?.rig_id) conditions.push(eq(beads.rig_id, filter.rig_id));

  const query = agentJoinQuery(db).$dynamic();
  if (conditions.length > 0) query.where(and(...conditions));

  const rows = query.orderBy(asc(beads.created_at)).all();
  return (rows as AgentJoinRow[]).map(toAgent);
}

export function updateAgentStatus(
  db: DrizzleSqliteDODatabase,
  agentId: string,
  status: string
): void {
  db.update(agent_metadata)
    .set({ status: status as 'idle' })
    .where(eq(agent_metadata.bead_id, agentId))
    .run();
}

export function deleteAgent(db: DrizzleSqliteDODatabase, agentId: string): void {
  // Unassign beads that reference this agent
  db.update(beads)
    .set({ assignee_agent_bead_id: null, status: 'open', updated_at: now() })
    .where(eq(beads.assignee_agent_bead_id, agentId))
    .run();

  // deleteBead cascades to agent_metadata, bead_events, bead_dependencies, etc.
  deleteBead(db, agentId);
}

// ── Hooks (GUPP) ────────────────────────────────────────────────────

export function hookBead(db: DrizzleSqliteDODatabase, agentId: string, beadId: string): void {
  const agent = getAgent(db, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const bead = getBead(db, beadId);
  if (!bead) throw new Error(`Bead ${beadId} not found`);

  // Already hooked to this bead — idempotent
  if (agent.current_hook_bead_id === beadId) return;

  // Agent already has a different hook — caller must unhook first
  if (agent.current_hook_bead_id) {
    throw new Error(
      `Agent ${agentId} is already hooked to bead ${agent.current_hook_bead_id}. Unhook first.`
    );
  }

  db.update(agent_metadata)
    .set({
      current_hook_bead_id: beadId,
      status: 'idle',
      dispatch_attempts: 0,
      last_activity_at: now(),
    })
    .where(eq(agent_metadata.bead_id, agentId))
    .run();

  db.update(beads)
    .set({
      status: 'in_progress',
      assignee_agent_bead_id: agentId,
      updated_at: now(),
    })
    .where(eq(beads.bead_id, beadId))
    .run();

  logBeadEvent(db, {
    beadId,
    agentId,
    eventType: 'hooked',
    newValue: agentId,
  });
}

export function unhookBead(db: DrizzleSqliteDODatabase, agentId: string): void {
  const agent = getAgent(db, agentId);
  if (!agent || !agent.current_hook_bead_id) return;

  const beadId = agent.current_hook_bead_id;

  db.update(agent_metadata)
    .set({ current_hook_bead_id: null, status: 'idle' })
    .where(eq(agent_metadata.bead_id, agentId))
    .run();

  logBeadEvent(db, {
    beadId,
    agentId,
    eventType: 'unhooked',
    oldValue: agentId,
  });
}

export function getHookedBead(db: DrizzleSqliteDODatabase, agentId: string): Bead | null {
  const agent = getAgent(db, agentId);
  if (!agent?.current_hook_bead_id) return null;
  return getBead(db, agent.current_hook_bead_id);
}

// ── Name Allocation ─────────────────────────────────────────────────

/**
 * Allocate a unique polecat name from the pool.
 * Names are town-global (agents belong to the town, not rigs) so we
 * check all existing polecats across every rig.
 */
export function allocatePolecatName(db: DrizzleSqliteDODatabase): string {
  const rows = db
    .select({ title: beads.title })
    .from(beads)
    .innerJoin(agent_metadata, eq(beads.bead_id, agent_metadata.bead_id))
    .where(eq(agent_metadata.role, 'polecat'))
    .all();

  const usedNames = new Set(rows.map(r => r.title));

  for (const name of POLECAT_NAME_POOL) {
    if (!usedNames.has(name)) return name;
  }

  // Fallback: sequential numbering beyond the 20-name pool
  return `Polecat-${usedNames.size + 1}`;
}

/**
 * Find an idle agent of the given role, or create one.
 * For singleton roles (witness, refinery, mayor), reuse existing.
 * For polecats, create a new one.
 */
export function getOrCreateAgent(
  db: DrizzleSqliteDODatabase,
  role: AgentRole,
  rigId: string,
  townId: string
): Agent {
  // Town-wide singletons: one per town, not tied to a rig.
  const townSingletonRoles = ['witness', 'mayor'];

  if (townSingletonRoles.includes(role)) {
    const existing = listAgents(db, { role });
    if (existing.length > 0) return existing[0];
  } else {
    // Per-rig agents (polecat, refinery): reuse an idle one in the SAME rig.
    // Agents are tied to a rig's worktree/repo — reusing one from a different
    // rig would dispatch it into the wrong repository.
    const row = agentJoinQuery(db)
      .where(
        and(
          eq(agent_metadata.role, role),
          eq(agent_metadata.status, 'idle'),
          isNull(agent_metadata.current_hook_bead_id),
          eq(beads.rig_id, rigId)
        )
      )
      .limit(1)
      .get();
    if (row) return toAgent(row as AgentJoinRow);
  }

  // Create a new agent
  const name = role === 'polecat' ? allocatePolecatName(db) : role;
  const identity = `${name}-${role}-${rigId.slice(0, 8)}@${townId.slice(0, 8)}`;

  return registerAgent(db, { role, name, identity, rig_id: rigId });
}

// ── Prime Context ───────────────────────────────────────────────────

export function prime(db: DrizzleSqliteDODatabase, agentId: string): PrimeContext {
  const agent = getAgent(db, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const hookedBead = agent.current_hook_bead_id ? getBead(db, agent.current_hook_bead_id) : null;

  const undeliveredMail = readAndDeliverMail(db, agentId);

  // Open beads (for context awareness, scoped to agent's rig)
  const openBeadRows = db
    .select()
    .from(beads)
    .where(
      and(
        inArray(beads.status, ['open', 'in_progress']),
        ne(beads.type, 'agent'),
        ne(beads.type, 'message'),
        or(isNull(beads.rig_id), eq(beads.rig_id, agent.rig_id ?? ''))
      )
    )
    .orderBy(desc(beads.created_at))
    .limit(20)
    .all();

  const openBeads = openBeadRows.map(parseBead);

  return {
    agent,
    hooked_bead: hookedBead,
    undelivered_mail: undeliveredMail,
    open_beads: openBeads,
  };
}

function parseBead(row: BeadsSelect): Bead {
  return {
    ...row,
    labels: JSON.parse(row.labels ?? '[]') as string[],
    metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
  };
}

// ── Checkpoint ──────────────────────────────────────────────────────

export function writeCheckpoint(db: DrizzleSqliteDODatabase, agentId: string, data: unknown): void {
  const serialized = data === null || data === undefined ? null : JSON.stringify(data);
  db.update(agent_metadata)
    .set({ checkpoint: serialized })
    .where(eq(agent_metadata.bead_id, agentId))
    .run();
}

export function readCheckpoint(db: DrizzleSqliteDODatabase, agentId: string): unknown {
  const agent = getAgent(db, agentId);
  return agent?.checkpoint ?? null;
}

// ── Touch (heartbeat helper) ────────────────────────────────────────

export function touchAgent(db: DrizzleSqliteDODatabase, agentId: string): void {
  db.update(agent_metadata)
    .set({ last_activity_at: now() })
    .where(eq(agent_metadata.bead_id, agentId))
    .run();
}
