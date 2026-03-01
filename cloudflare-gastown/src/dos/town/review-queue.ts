/**
 * Review queue and molecule management for the Town DO.
 *
 * After the beads-centric refactor (#441):
 * - Review queue entries are beads with type='merge_request' + review_metadata satellite
 * - Molecules are parent beads with type='molecule' + child step beads
 */

import { z } from 'zod';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { eq, and, asc, lt, sql, getTableColumns } from 'drizzle-orm';
import { beads, review_metadata, bead_dependencies, agent_metadata } from '../../db/sqlite-schema';
import { logBeadEvent, getBead, closeBead, updateBeadStatus, createBead, parseBead } from './beads';
import { getAgent, unhookBead } from './agents';
import type { ReviewQueueInput, ReviewQueueEntry, AgentDoneInput, Molecule } from '../../types';

// Review entries stuck in 'running' past this timeout are reset to 'pending'
const REVIEW_RUNNING_TIMEOUT_MS = 5 * 60 * 1000;

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// ── Review Queue ────────────────────────────────────────────────────

const reviewJoinColumns = {
  ...getTableColumns(beads),
  branch: review_metadata.branch,
  target_branch: review_metadata.target_branch,
  merge_commit: review_metadata.merge_commit,
  pr_url: review_metadata.pr_url,
  retry_count: review_metadata.retry_count,
};

function reviewJoinQuery(db: DrizzleSqliteDODatabase) {
  return db
    .select(reviewJoinColumns)
    .from(beads)
    .innerJoin(review_metadata, eq(beads.bead_id, review_metadata.bead_id));
}

// Derive the row type from the query builder — stays in sync with schema automatically.
type ReviewJoinRow = NonNullable<ReturnType<ReturnType<typeof reviewJoinQuery>['get']>>;

/** Map a review join row to the ReviewQueueEntry API type. */
function toReviewQueueEntry(row: ReviewJoinRow): ReviewQueueEntry {
  const metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
  return {
    id: row.bead_id,
    // The polecat that submitted the review — stored in metadata (not assignee,
    // which is set to the refinery when it claims the MR bead via hookBead).
    agent_id:
      typeof metadata?.source_agent_id === 'string'
        ? metadata.source_agent_id
        : (row.created_by ?? ''),
    bead_id: typeof metadata?.source_bead_id === 'string' ? metadata.source_bead_id : row.bead_id,
    rig_id: row.rig_id ?? '',
    branch: row.branch,
    pr_url: row.pr_url,
    status:
      row.status === 'open'
        ? 'pending'
        : row.status === 'in_progress'
          ? 'running'
          : row.status === 'closed'
            ? 'merged'
            : 'failed',
    summary: row.body,
    created_at: row.created_at,
    processed_at: row.updated_at === row.created_at ? null : row.updated_at,
  };
}

export function submitToReviewQueue(db: DrizzleSqliteDODatabase, input: ReviewQueueInput): void {
  const id = generateId();
  const timestamp = now();

  // Create the merge_request bead
  db.insert(beads)
    .values({
      bead_id: id,
      type: 'merge_request',
      status: 'open',
      title: `Review: ${input.branch}`,
      body: input.summary ?? null,
      rig_id: input.rig_id,
      parent_bead_id: null,
      assignee_agent_bead_id: null, // assignee left null — refinery claims it via hookBead
      priority: 'medium',
      labels: JSON.stringify(['gt:merge-request']),
      metadata: JSON.stringify({ source_bead_id: input.bead_id, source_agent_id: input.agent_id }),
      created_by: input.agent_id, // created_by records who submitted
      created_at: timestamp,
      updated_at: timestamp,
      closed_at: null,
    })
    .run();

  // Link MR bead → source bead via bead_dependencies so the DAG is queryable
  db.insert(bead_dependencies)
    .values({
      bead_id: id,
      depends_on_bead_id: input.bead_id,
      dependency_type: 'tracks',
    })
    .run();

  // Create the review_metadata satellite
  db.insert(review_metadata)
    .values({
      bead_id: id,
      branch: input.branch,
      target_branch: 'main',
      merge_commit: null,
      pr_url: input.pr_url ?? null,
      retry_count: 0,
    })
    .run();

  logBeadEvent(db, {
    beadId: input.bead_id,
    agentId: input.agent_id,
    eventType: 'review_submitted',
    newValue: input.branch,
    metadata: { branch: input.branch },
  });
}

export function popReviewQueue(db: DrizzleSqliteDODatabase): ReviewQueueEntry | null {
  const row = reviewJoinQuery(db)
    .where(eq(beads.status, 'open'))
    .orderBy(asc(beads.created_at))
    .limit(1)
    .get();

  if (!row) return null;
  const entry = toReviewQueueEntry(row);

  // Mark as running (in_progress)
  db.update(beads)
    .set({ status: 'in_progress', updated_at: now() })
    .where(eq(beads.bead_id, entry.id))
    .run();

  return { ...entry, status: 'running', processed_at: now() };
}

export function completeReview(
  db: DrizzleSqliteDODatabase,
  entryId: string,
  status: 'merged' | 'failed'
): void {
  const beadStatus = status === 'merged' ? 'closed' : 'failed';
  const timestamp = now();
  db.update(beads)
    .set({
      status: beadStatus,
      updated_at: timestamp,
      closed_at: beadStatus === 'closed' ? timestamp : null,
    })
    .where(eq(beads.bead_id, entryId))
    .run();
}

/**
 * Complete a review with full result handling (close bead on merge, escalate on conflict).
 */
export function completeReviewWithResult(
  db: DrizzleSqliteDODatabase,
  input: {
    entry_id: string;
    status: 'merged' | 'failed' | 'conflict';
    message?: string;
    commit_sha?: string;
  }
): void {
  // On conflict, mark the review entry as failed and create an escalation bead
  const resolvedStatus = input.status === 'conflict' ? 'failed' : input.status;
  completeReview(db, input.entry_id, resolvedStatus);

  // Find the review entry to get agent IDs
  const row = reviewJoinQuery(db).where(eq(beads.bead_id, input.entry_id)).get();
  if (!row) return;
  const entry = toReviewQueueEntry(row);

  logBeadEvent(db, {
    beadId: entry.bead_id,
    agentId: entry.agent_id,
    eventType: 'review_completed',
    newValue: input.status,
    metadata: {
      message: input.message,
      commit_sha: input.commit_sha,
    },
  });

  if (input.status === 'merged') {
    closeBead(db, entry.bead_id, entry.agent_id);
  } else if (input.status === 'conflict') {
    // Create an escalation bead so the conflict is visible and actionable
    createBead(db, {
      type: 'escalation',
      title: `Merge conflict: ${input.message ?? entry.branch}`,
      body: input.message,
      priority: 'high',
      metadata: {
        source_bead_id: entry.bead_id,
        source_agent_id: entry.agent_id,
        branch: entry.branch,
        conflict: true,
      },
    });
  }
}

export function recoverStuckReviews(db: DrizzleSqliteDODatabase): void {
  const timeout = new Date(Date.now() - REVIEW_RUNNING_TIMEOUT_MS).toISOString();
  db.update(beads)
    .set({ status: 'open', updated_at: now() })
    .where(
      and(
        eq(beads.type, 'merge_request'),
        eq(beads.status, 'in_progress'),
        lt(beads.updated_at, timeout)
      )
    )
    .run();
}

// ── Agent Done ──────────────────────────────────────────────────────

export function agentDone(
  db: DrizzleSqliteDODatabase,
  agentId: string,
  input: AgentDoneInput
): void {
  const agent = getAgent(db, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (!agent.current_hook_bead_id) throw new Error(`Agent ${agentId} has no hooked bead`);

  if (agent.role === 'refinery') {
    // The refinery is hooked to the MR bead. Mark it as merged and log
    // the review_completed event on the source bead.
    const mrBeadId = agent.current_hook_bead_id;
    completeReviewFromMRBead(db, mrBeadId, agentId);
    unhookBead(db, agentId);
    return;
  }

  const sourceBead = agent.current_hook_bead_id;

  if (!agent.rig_id) {
    console.warn(
      `[review-queue] agentDone: agent ${agentId} has null rig_id — review entry may fail in processReviewQueue`
    );
  }

  submitToReviewQueue(db, {
    agent_id: agentId,
    bead_id: sourceBead,
    rig_id: agent.rig_id ?? '',
    branch: input.branch,
    pr_url: input.pr_url,
    summary: input.summary,
  });

  // Close the source bead (matches upstream gt done behavior). The polecat's
  // work is done — the MR bead now tracks the merge lifecycle. The source
  // bead retains its assignee so we know which agent worked on it.
  unhookBead(db, agentId);
  closeBead(db, sourceBead, agentId);
}

/**
 * Complete a review given the MR bead id directly (the refinery is hooked
 * to the MR bead). Marks the MR as merged and logs a review_completed
 * event on the source bead. The source bead itself is already closed by
 * the polecat's agentDone path.
 */
function completeReviewFromMRBead(
  db: DrizzleSqliteDODatabase,
  mrBeadId: string,
  agentId: string
): void {
  const mrBead = getBead(db, mrBeadId);
  if (!mrBead) {
    console.error(
      `[review-queue] completeReviewFromMRBead: MR bead ${mrBeadId} not found — data integrity issue`
    );
    return;
  }
  const sourceBeadId = mrBead.metadata?.source_bead_id;

  completeReview(db, mrBeadId, 'merged');

  if (typeof sourceBeadId === 'string') {
    logBeadEvent(db, {
      beadId: sourceBeadId,
      agentId,
      eventType: 'review_completed',
      newValue: 'merged',
      metadata: { completedBy: 'refinery', mr_bead_id: mrBeadId },
    });
  }
}

/**
 * Called by the container when an agent process completes (or fails).
 * Closes/fails the bead and unhooks the agent.
 */
export function agentCompleted(
  db: DrizzleSqliteDODatabase,
  agentId: string,
  input: { status: 'completed' | 'failed'; reason?: string }
): void {
  const agent = getAgent(db, agentId);
  if (!agent) return;

  if (agent.current_hook_bead_id) {
    const beadStatus = input.status === 'completed' ? 'closed' : 'failed';
    updateBeadStatus(db, agent.current_hook_bead_id, beadStatus, agentId);
    unhookBead(db, agentId);
  }

  // Mark agent idle
  db.update(agent_metadata)
    .set({ status: 'idle', dispatch_attempts: 0 })
    .where(eq(agent_metadata.bead_id, agentId))
    .run();
}

// ── Molecules ───────────────────────────────────────────────────────

/**
 * Create a molecule: a parent bead with type='molecule', child step beads
 * linked via parent_bead_id, and step ordering via bead_dependencies.
 */
export function createMolecule(
  db: DrizzleSqliteDODatabase,
  beadId: string,
  formula: unknown
): Molecule {
  const id = generateId();
  const timestamp = now();
  const formulaArr = Array.isArray(formula) ? formula : [];

  // Create the molecule parent bead
  db.insert(beads)
    .values({
      bead_id: id,
      type: 'molecule',
      status: 'open',
      title: `Molecule for bead ${beadId}`,
      body: null,
      rig_id: null,
      parent_bead_id: null,
      assignee_agent_bead_id: null,
      priority: 'medium',
      labels: JSON.stringify(['gt:molecule']),
      metadata: JSON.stringify({ source_bead_id: beadId, formula }),
      created_by: null,
      created_at: timestamp,
      updated_at: timestamp,
      closed_at: null,
    })
    .run();

  // Create child step beads and dependency chain
  let prevStepId: string | null = null;
  for (let i = 0; i < formulaArr.length; i++) {
    const stepId = generateId();
    const step = formulaArr[i];

    db.insert(beads)
      .values({
        bead_id: stepId,
        type: 'issue',
        status: 'open',
        title: z.object({ title: z.string() }).safeParse(step).data?.title ?? `Step ${i + 1}`,
        body: typeof step === 'string' ? step : JSON.stringify(step),
        rig_id: null,
        parent_bead_id: id,
        assignee_agent_bead_id: null,
        priority: 'medium',
        labels: JSON.stringify(['gt:molecule-step', `step:${i}`]),
        metadata: JSON.stringify({ step_index: i, step_data: step }),
        created_by: null,
        created_at: timestamp,
        updated_at: timestamp,
        closed_at: null,
      })
      .run();

    // Chain dependencies: each step blocks on the previous
    if (prevStepId) {
      db.insert(bead_dependencies)
        .values({
          bead_id: stepId,
          depends_on_bead_id: prevStepId,
          dependency_type: 'blocks',
        })
        .run();
    }
    prevStepId = stepId;
  }

  // Link molecule to source bead in metadata
  db.update(beads)
    .set({
      metadata: sql`json_set(${beads.metadata}, '$.molecule_bead_id', ${id})`,
    })
    .where(eq(beads.bead_id, beadId))
    .run();

  const mol = getMolecule(db, id);
  if (!mol) throw new Error('Failed to create molecule');
  return mol;
}

/**
 * Get a molecule by its bead_id. Derives current_step and status from children.
 */
export function getMolecule(db: DrizzleSqliteDODatabase, moleculeId: string): Molecule | null {
  const bead = getBead(db, moleculeId);
  if (!bead || bead.type !== 'molecule') return null;

  const steps = getStepBeads(db, moleculeId);
  const closedCount = steps.filter(s => s.status === 'closed').length;
  const failedCount = steps.filter(s => s.status === 'failed').length;

  const currentStep = closedCount;
  const status =
    failedCount > 0
      ? 'failed'
      : closedCount >= steps.length && steps.length > 0
        ? 'completed'
        : 'active';

  const formula = bead.metadata?.formula ?? [];

  return {
    id: moleculeId,
    bead_id: String(bead.metadata?.source_bead_id ?? moleculeId),
    formula,
    current_step: currentStep,
    status,
    created_at: bead.created_at,
    updated_at: bead.updated_at,
  };
}

type ParsedBead = ReturnType<typeof parseBead>;

function getStepBeads(db: DrizzleSqliteDODatabase, moleculeId: string): ParsedBead[] {
  const rows = db
    .select()
    .from(beads)
    .where(eq(beads.parent_bead_id, moleculeId))
    .orderBy(asc(beads.created_at))
    .all();
  return rows.map(parseBead);
}

export function getMoleculeForBead(db: DrizzleSqliteDODatabase, beadId: string): Molecule | null {
  const bead = getBead(db, beadId);
  if (!bead) return null;
  const moleculeId = bead.metadata?.molecule_bead_id;
  if (typeof moleculeId !== 'string') return null;
  return getMolecule(db, moleculeId);
}

export function getMoleculeCurrentStep(
  db: DrizzleSqliteDODatabase,
  agentId: string
): { molecule: Molecule; step: unknown } | null {
  const agent = getAgent(db, agentId);
  if (!agent?.current_hook_bead_id) return null;

  const mol = getMoleculeForBead(db, agent.current_hook_bead_id);
  if (!mol || mol.status !== 'active') return null;

  const formula = mol.formula;
  if (!Array.isArray(formula)) return null;

  const step = formula[mol.current_step] ?? null;
  return { molecule: mol, step };
}

export function advanceMoleculeStep(
  db: DrizzleSqliteDODatabase,
  agentId: string,
  _summary: string
): Molecule | null {
  const current = getMoleculeCurrentStep(db, agentId);
  if (!current) return null;

  const { molecule } = current;

  // Close the current step bead
  const steps = getStepBeads(db, molecule.id);
  const currentStepBead = steps[molecule.current_step];
  if (currentStepBead) {
    const timestamp = now();
    db.update(beads)
      .set({ status: 'closed', closed_at: timestamp, updated_at: timestamp })
      .where(eq(beads.bead_id, currentStepBead.bead_id))
      .run();
  }

  // Check if molecule is now complete
  const formula = molecule.formula;
  const nextStep = molecule.current_step + 1;
  const isComplete = !Array.isArray(formula) || nextStep >= formula.length;

  if (isComplete) {
    // Close the molecule bead itself
    const timestamp = now();
    db.update(beads)
      .set({ status: 'closed', closed_at: timestamp, updated_at: timestamp })
      .where(eq(beads.bead_id, molecule.id))
      .run();
  }

  return getMolecule(db, molecule.id);
}
