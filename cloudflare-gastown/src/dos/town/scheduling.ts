/**
 * Agent scheduling and dispatch for the Town DO alarm loop.
 *
 * Owns the core dispatch/retry logic that was previously inline in
 * Town.do.ts. The Town DO delegates to these pure(ish) functions,
 * passing its SQL handle and env bindings.
 */

import * as Sentry from '@sentry/cloudflare';
import { beads, AgentBeadRecord } from '../../db/tables/beads.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { query } from '../../util/query.util';
import * as beadOps from './beads';
import * as agents from './agents';
import * as rigs from './rigs';
import * as dispatch from './container-dispatch';
import * as patrol from './patrol';
import type { Agent, Bead, TownConfig } from '../../types';
import type { GastownEventData } from '../../util/analytics.util';

const LOG = '[scheduling]';

// ── Constants ──────────────────────────────────────────────────────────

export const DISPATCH_COOLDOWN_MS = 2 * 60_000; // 2 min
export const MAX_DISPATCH_ATTEMPTS = 5;

// ── Context passed by the Town DO ──────────────────────────────────────

type SchedulingContext = {
  sql: SqlStorage;
  env: Env;
  storage: DurableObjectStorage;
  townId: string;
  getTownConfig: () => Promise<TownConfig>;
  getRigConfig: (rigId: string) => Promise<RigConfig | null>;
  resolveKilocodeToken: () => Promise<string | undefined>;
  emitEvent: (data: Omit<GastownEventData, 'userId' | 'delivery'>) => void;
};

type RigConfig = {
  townId: string;
  rigId: string;
  gitUrl: string;
  defaultBranch: string;
  userId: string;
  kilocodeToken?: string;
  platformIntegrationId?: string;
  merge_strategy?: string;
};

function now(): string {
  return new Date().toISOString();
}

// ── dispatchAgent ──────────────────────────────────────────────────────

/**
 * Dispatch a single agent to the container. Transitions the bead to
 * in_progress and the agent to working BEFORE the async network call
 * (I/O gate safety for fire-and-forget callers). Returns true if the
 * container accepted the agent.
 */
export async function dispatchAgent(
  ctx: SchedulingContext,
  agent: Agent,
  bead: Bead,
  options?: { systemPromptOverride?: string }
): Promise<boolean> {
  try {
    const rigId = agent.rig_id ?? rigs.listRigs(ctx.sql)[0]?.id ?? '';
    const rigConfig = rigId ? await ctx.getRigConfig(rigId) : null;
    if (!rigConfig) {
      console.warn(`${LOG} dispatchAgent: no rig config for agent=${agent.id} rig=${rigId}`);
      return false;
    }

    const townConfig = await ctx.getTownConfig();
    const kilocodeToken = await ctx.resolveKilocodeToken();

    const convoyId = beadOps.getConvoyForBead(ctx.sql, bead.bead_id);
    const convoyFeatureBranch = convoyId ? beadOps.getConvoyFeatureBranch(ctx.sql, convoyId) : null;

    // Transition bead to in_progress BEFORE the async container start.
    // Must happen synchronously within the I/O gate — fire-and-forget
    // callers (slingBead, slingConvoy) close the gate before the
    // network call completes.
    const currentBead = beadOps.getBead(ctx.sql, bead.bead_id);
    if (
      currentBead &&
      currentBead.status !== 'in_progress' &&
      currentBead.status !== 'closed' &&
      currentBead.status !== 'failed'
    ) {
      beadOps.updateBeadStatus(ctx.sql, bead.bead_id, 'in_progress', agent.id);
    }

    // Set agent to 'working' BEFORE the async container start (same
    // I/O gate rationale).
    const timestamp = now();
    query(
      ctx.sql,
      /* sql */ `
        UPDATE ${agent_metadata}
        SET ${agent_metadata.columns.status} = 'working',
            ${agent_metadata.columns.dispatch_attempts} = ${agent_metadata.columns.dispatch_attempts} + 1,
            ${agent_metadata.columns.last_activity_at} = ?
        WHERE ${agent_metadata.bead_id} = ?
      `,
      [timestamp, agent.id]
    );

    const started = await dispatch.startAgentInContainer(ctx.env, ctx.storage, {
      townId: ctx.townId,
      rigId,
      userId: rigConfig.userId,
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      identity: agent.identity,
      beadId: bead.bead_id,
      beadTitle: bead.title,
      beadBody: bead.body ?? '',
      checkpoint: agent.checkpoint,
      gitUrl: rigConfig.gitUrl,
      defaultBranch: rigConfig.defaultBranch,
      kilocodeToken,
      townConfig,
      platformIntegrationId: rigConfig.platformIntegrationId,
      convoyFeatureBranch: convoyFeatureBranch ?? undefined,
      systemPromptOverride: options?.systemPromptOverride,
    });

    if (started) {
      // Best-effort: may be dropped if I/O gate is closed
      query(
        ctx.sql,
        /* sql */ `
          UPDATE ${agent_metadata}
          SET ${agent_metadata.columns.dispatch_attempts} = 0
          WHERE ${agent_metadata.bead_id} = ?
        `,
        [agent.id]
      );
      console.log(`${LOG} dispatchAgent: started agent=${agent.name}(${agent.id})`);
      ctx.emitEvent({
        event: 'agent.spawned',
        townId: ctx.townId,
        rigId,
        agentId: agent.id,
        beadId: bead.bead_id,
        role: agent.role,
      });
    } else {
      // Container failed — roll back agent to idle, bead to open.
      // Use bead.bead_id (the actual bead being dispatched) rather than
      // agent.current_hook_bead_id which may be stale if the agent
      // snapshot was taken before hookBead was called.
      query(
        ctx.sql,
        /* sql */ `
          UPDATE ${agent_metadata}
          SET ${agent_metadata.columns.status} = 'idle'
          WHERE ${agent_metadata.bead_id} = ?
        `,
        [agent.id]
      );
      beadOps.updateBeadStatus(ctx.sql, bead.bead_id, 'open', agent.id);
      ctx.emitEvent({
        event: 'agent.dispatch_failed',
        townId: ctx.townId,
        rigId,
        agentId: agent.id,
        beadId: bead.bead_id,
        role: agent.role,
      });
    }
    return started;
  } catch (err) {
    console.error(`${LOG} dispatchAgent: failed for agent=${agent.id}:`, err);
    Sentry.captureException(err, { extra: { agentId: agent.id, beadId: bead.bead_id } });
    try {
      query(
        ctx.sql,
        /* sql */ `
          UPDATE ${agent_metadata}
          SET ${agent_metadata.columns.status} = 'idle'
          WHERE ${agent_metadata.bead_id} = ?
        `,
        [agent.id]
      );
      beadOps.updateBeadStatus(ctx.sql, bead.bead_id, 'open', agent.id);
    } catch (rollbackErr) {
      console.error(`${LOG} dispatchAgent: rollback also failed:`, rollbackErr);
    }
    ctx.emitEvent({
      event: 'agent.dispatch_failed',
      townId: ctx.townId,
      agentId: agent.id,
      beadId: bead.bead_id,
      role: agent.role,
    });
    return false;
  }
}

// ── dispatchUnblockedBeads ─────────────────────────────────────────────

/**
 * When a bead closes, find beads that were blocked by it and are now
 * fully unblocked. Dispatch their assigned agents (fire-and-forget).
 */
export function dispatchUnblockedBeads(ctx: SchedulingContext, closedBeadId: string): void {
  const unblockedIds = beadOps.getNewlyUnblockedBeads(ctx.sql, closedBeadId);
  if (unblockedIds.length === 0) return;

  console.log(
    `${LOG} dispatchUnblockedBeads: ${unblockedIds.length} beads unblocked by ${closedBeadId}`
  );

  for (const beadId of unblockedIds) {
    const bead = beadOps.getBead(ctx.sql, beadId);
    if (!bead || bead.status === 'closed' || bead.status === 'failed') continue;

    if (!bead.assignee_agent_bead_id) continue;
    const agent = agents.getAgent(ctx.sql, bead.assignee_agent_bead_id);
    if (!agent || agent.status !== 'idle') continue;

    dispatchAgent(ctx, agent, bead).catch(err =>
      console.error(
        `${LOG} dispatchUnblockedBeads: fire-and-forget dispatch failed for bead=${beadId}`,
        err
      )
    );
  }
}

// ── schedulePendingWork ────────────────────────────────────────────────

/**
 * Find idle agents with hooked beads and dispatch them. Agents within
 * the dispatch cooldown are skipped (fire-and-forget dispatch in flight).
 *
 * Refineries are excluded — they must go through processReviewQueue so
 * they receive the full system prompt with branch, strategy, and gate
 * context. recoverStuckReviews resets their MR bead to 'open' after the
 * timeout, and processReviewQueue re-pops it with the correct prompt.
 */
export async function schedulePendingWork(ctx: SchedulingContext): Promise<void> {
  const cooldownCutoff = new Date(Date.now() - DISPATCH_COOLDOWN_MS).toISOString();
  const rows = [
    ...query(
      ctx.sql,
      /* sql */ `
        SELECT ${beads}.*,
               ${agent_metadata.role}, ${agent_metadata.identity},
               ${agent_metadata.container_process_id},
               ${agent_metadata.status} AS status,
               ${agent_metadata.current_hook_bead_id},
               ${agent_metadata.dispatch_attempts}, ${agent_metadata.last_activity_at},
               ${agent_metadata.checkpoint},
               ${agent_metadata.agent_status_message}, ${agent_metadata.agent_status_updated_at}
        FROM ${beads}
        INNER JOIN ${agent_metadata} ON ${beads.bead_id} = ${agent_metadata.bead_id}
        WHERE ${agent_metadata.status} = 'idle'
          AND ${agent_metadata.current_hook_bead_id} IS NOT NULL
          AND ${agent_metadata.role} != 'refinery'
          AND (${agent_metadata.last_activity_at} IS NULL OR ${agent_metadata.last_activity_at} < ?)
      `,
      [cooldownCutoff]
    ),
  ];
  const pendingAgents: Agent[] = AgentBeadRecord.array()
    .parse(rows)
    .map(row => ({
      id: row.bead_id,
      rig_id: row.rig_id,
      role: row.role,
      name: row.title,
      identity: row.identity,
      status: row.status,
      current_hook_bead_id: row.current_hook_bead_id,
      dispatch_attempts: row.dispatch_attempts,
      last_activity_at: row.last_activity_at,
      checkpoint: row.checkpoint,
      created_at: row.created_at,
      agent_status_message: row.agent_status_message,
      agent_status_updated_at: row.agent_status_updated_at,
    }));

  console.log(`${LOG} schedulePendingWork: found ${pendingAgents.length} pending agents`);
  if (pendingAgents.length === 0) return;

  const dispatchTasks: Array<() => Promise<void>> = [];

  for (const agent of pendingAgents) {
    const beadId = agent.current_hook_bead_id;
    if (!beadId) continue;
    const bead = beadOps.getBead(ctx.sql, beadId);
    if (!bead) continue;

    if (agent.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS) {
      beadOps.updateBeadStatus(ctx.sql, beadId, 'failed', agent.id);
      agents.unhookBead(ctx.sql, agent.id);
      continue;
    }

    if (beadOps.hasUnresolvedBlockers(ctx.sql, beadId)) {
      continue;
    }

    dispatchTasks.push(async () => {
      await dispatchAgent(ctx, agent, bead);
    });
  }

  if (dispatchTasks.length > 0) {
    await Promise.allSettled(dispatchTasks.map(fn => fn()));
  }
}

// ── hasActiveWork ──────────────────────────────────────────────────────

/**
 * Returns true if the town has work that requires the fast (5s) alarm
 * interval. Used to decide between active and idle alarm cadence.
 */
export function hasActiveWork(sql: SqlStorage): boolean {
  const activeAgentRows = [
    ...query(
      sql,
      /* sql */ `SELECT COUNT(*) as cnt FROM ${agent_metadata} WHERE ${agent_metadata.status} IN ('working', 'stalled')`,
      []
    ),
  ];
  const pendingBeadRows = [
    ...query(
      sql,
      /* sql */ `SELECT COUNT(*) as cnt FROM ${agent_metadata} WHERE ${agent_metadata.status} = 'idle' AND ${agent_metadata.current_hook_bead_id} IS NOT NULL`,
      []
    ),
  ];
  const pendingReviewRows = [
    ...query(
      sql,
      /* sql */ `SELECT COUNT(*) as cnt FROM ${beads} WHERE ${beads.type} = 'merge_request' AND ${beads.status} IN ('open', 'in_progress')`,
      []
    ),
  ];
  const pendingTriageRows = [
    ...query(
      sql,
      /* sql */ `SELECT COUNT(*) as cnt FROM ${beads} WHERE ${beads.type} = 'issue' AND ${beads.labels} LIKE ? AND ${beads.status} = 'open'`,
      [patrol.TRIAGE_LABEL_LIKE]
    ),
  ];
  return (
    Number(activeAgentRows[0]?.cnt ?? 0) > 0 ||
    Number(pendingBeadRows[0]?.cnt ?? 0) > 0 ||
    Number(pendingReviewRows[0]?.cnt ?? 0) > 0 ||
    Number(pendingTriageRows[0]?.cnt ?? 0) > 0
  );
}
