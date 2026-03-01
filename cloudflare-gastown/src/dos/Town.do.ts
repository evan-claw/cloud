/**
 * TownDO — The single source of truth for all control-plane data.
 *
 * After the town-centric refactor (#419), ALL gastown state lives here:
 * rigs, agents, beads, mail, review queues, molecules, bead events,
 * convoys, escalations, and configuration.
 *
 * After the beads-centric refactor (#441), all object types are unified
 * into the beads table with satellite metadata tables. Separate tables
 * for mail, molecules, review queue, convoys, and escalations are eliminated.
 *
 * Agent events (high-volume SSE/streaming data) are delegated to per-agent
 * AgentDOs to stay within the 10GB DO SQLite limit.
 */

import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import {
  eq,
  and,
  or,
  sql,
  count,
  desc,
  inArray,
  isNull,
  isNotNull,
  getTableColumns,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import migrations from '../../drizzle/migrations';

// Sub-modules (plain functions, not classes — per coding style)
import * as beadOps from './town/beads';
import * as agents from './town/agents';
import * as mail from './town/mail';
import * as reviewQueue from './town/review-queue';
import * as config from './town/config';
import * as rigs from './town/rigs';
import * as dispatch from './town/container-dispatch';

// Table + type imports for beads-centric operations
import {
  beads,
  agent_metadata,
  escalation_metadata,
  convoy_metadata,
  bead_dependencies,
  type BeadsSelect,
} from '../db/sqlite-schema';
import { getAgentDOStub } from './Agent.do';
import { getTownContainerStub } from './TownContainer.do';

import { BeadPriority, BeadStatus } from '../types';
import type {
  TownConfig,
  TownConfigUpdate,
  CreateBeadInput,
  BeadFilter,
  Bead,
  RegisterAgentInput,
  AgentFilter,
  Agent,
  AgentRole,
  SendMailInput,
  Mail,
  ReviewQueueInput,
  ReviewQueueEntry,
  AgentDoneInput,
  PrimeContext,
  Molecule,
  BeadEventRecord,
} from '../types';

const TOWN_LOG = '[Town.do]';

// Alarm intervals
const ACTIVE_ALARM_INTERVAL_MS = 15_000; // 15s when agents are active
const IDLE_ALARM_INTERVAL_MS = 5 * 60_000; // 5m when idle
const DISPATCH_COOLDOWN_MS = 2 * 60_000; // 2 min — skip agents with recent dispatch activity
const GUPP_THRESHOLD_MS = 30 * 60_000; // 30 min
const MAX_DISPATCH_ATTEMPTS = 5;

// Escalation constants
const STALE_ESCALATION_THRESHOLD_MS = 4 * 60 * 60 * 1000;
const MAX_RE_ESCALATIONS = 3;
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'] as const;

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// ── Rig config stored per-rig in KV (mirrors what was in Rig DO) ────
type RigConfig = {
  townId: string;
  rigId: string;
  gitUrl: string;
  defaultBranch: string;
  userId: string;
  kilocodeToken?: string;
  platformIntegrationId?: string;
};

// ── Drizzle join column sets ────────────────────────────────────────

const escalationJoinColumns = {
  ...getTableColumns(beads),
  severity: escalation_metadata.severity,
  category: escalation_metadata.category,
  acknowledged: escalation_metadata.acknowledged,
  re_escalation_count: escalation_metadata.re_escalation_count,
  acknowledged_at: escalation_metadata.acknowledged_at,
};

const convoyJoinColumns = {
  ...getTableColumns(beads),
  total_beads: convoy_metadata.total_beads,
  closed_beads: convoy_metadata.closed_beads,
  landed_at: convoy_metadata.landed_at,
};

// ── Parse helpers for joined rows ───────────────────────────────────

function parseBead(row: BeadsSelect): Bead {
  return {
    ...row,
    labels: JSON.parse(row.labels ?? '[]'),
    metadata: JSON.parse(row.metadata ?? '{}'),
  };
}

// Escalation join row — the shape returned by selecting escalationJoinColumns
type EscalationJoinRow = {
  bead_id: string;
  type: string;
  status: string;
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
  severity: string;
  category: string | null;
  acknowledged: number;
  re_escalation_count: number;
  acknowledged_at: string | null;
};

// Convoy join row — the shape returned by selecting convoyJoinColumns
type ConvoyJoinRow = {
  bead_id: string;
  type: string;
  status: string;
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
  total_beads: number;
  closed_beads: number;
  landed_at: string | null;
};

// ── Escalation API type ─────────────────────────────────────────────
type EscalationEntry = {
  id: string;
  source_rig_id: string;
  source_agent_id: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string | null;
  message: string;
  acknowledged: number;
  re_escalation_count: number;
  created_at: string;
  acknowledged_at: string | null;
};

function toEscalation(row: EscalationJoinRow): EscalationEntry {
  return {
    id: row.bead_id,
    source_rig_id: row.rig_id ?? '',
    source_agent_id: row.created_by,
    severity: row.severity as EscalationEntry['severity'],
    category: row.category,
    message: row.body ?? row.title,
    acknowledged: row.acknowledged,
    re_escalation_count: row.re_escalation_count,
    created_at: row.created_at,
    acknowledged_at: row.acknowledged_at,
  };
}

// ── Convoy API type ─────────────────────────────────────────────────
type ConvoyEntry = {
  id: string;
  title: string;
  status: 'active' | 'landed';
  total_beads: number;
  closed_beads: number;
  created_by: string | null;
  created_at: string;
  landed_at: string | null;
};

function toConvoy(row: ConvoyJoinRow): ConvoyEntry {
  return {
    id: row.bead_id,
    title: row.title,
    status: row.status === 'closed' ? 'landed' : 'active',
    total_beads: row.total_beads,
    closed_beads: row.closed_beads,
    created_by: row.created_by,
    created_at: row.created_at,
    landed_at: row.landed_at,
  };
}

export class TownDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations);
      // Load persisted town ID if available
      const storedId = await ctx.storage.get<string>('town:id');
      if (storedId) this._townId = storedId;
    });
  }

  private _townId: string | null = null;

  private get townId(): string {
    return this._townId ?? this.ctx.id.name ?? this.ctx.id.toString();
  }

  /**
   * Explicitly set the town ID. Called by configureRig or any handler
   * that knows the real town UUID, so that subsequent internal calls
   * (alarm, sendMayorMessage) use the correct ID for container stubs.
   */
  async setTownId(townId: string): Promise<void> {
    this._townId = townId;
    await this.ctx.storage.put('town:id', townId);
  }

  // ══════════════════════════════════════════════════════════════════
  // Town Configuration
  // ══════════════════════════════════════════════════════════════════

  async getTownConfig(): Promise<TownConfig> {
    return config.getTownConfig(this.ctx.storage);
  }

  async updateTownConfig(update: TownConfigUpdate): Promise<TownConfig> {
    return config.updateTownConfig(this.ctx.storage, update);
  }

  // ══════════════════════════════════════════════════════════════════
  // Rig Registry
  // ══════════════════════════════════════════════════════════════════

  async addRig(input: {
    rigId: string;
    name: string;
    gitUrl: string;
    defaultBranch: string;
  }): Promise<rigs.RigRecord> {
    return rigs.addRig(this.db, input);
  }

  async removeRig(rigId: string): Promise<void> {
    rigs.removeRig(this.db, rigId);
    await this.ctx.storage.delete(`rig:${rigId}:config`);
    // Delete all beads belonging to this rig (cascades to satellite tables via deleteBead)
    const rigBeads = this.db
      .select({ bead_id: beads.bead_id })
      .from(beads)
      .where(eq(beads.rig_id, rigId))
      .all();
    for (const { bead_id } of rigBeads) {
      beadOps.deleteBead(this.db, bead_id);
    }
  }

  async listRigs(): Promise<rigs.RigRecord[]> {
    return rigs.listRigs(this.db);
  }

  async getRigAsync(rigId: string): Promise<rigs.RigRecord | null> {
    return rigs.getRig(this.db, rigId);
  }

  // ── Rig Config (KV, per-rig — configuration needed for container dispatch) ──

  async configureRig(rigConfig: RigConfig): Promise<void> {
    console.log(
      `${TOWN_LOG} configureRig: rigId=${rigConfig.rigId} hasKilocodeToken=${!!rigConfig.kilocodeToken}`
    );
    if (rigConfig.townId) {
      await this.setTownId(rigConfig.townId);
    }
    await this.ctx.storage.put(`rig:${rigConfig.rigId}:config`, rigConfig);

    if (rigConfig.kilocodeToken) {
      const townConfig = await this.getTownConfig();
      if (!townConfig.kilocode_token || townConfig.kilocode_token !== rigConfig.kilocodeToken) {
        console.log(`${TOWN_LOG} configureRig: propagating kilocodeToken to town config`);
        await this.updateTownConfig({ kilocode_token: rigConfig.kilocodeToken });
      }
    }

    const token = rigConfig.kilocodeToken ?? (await this.resolveKilocodeToken());
    if (token) {
      try {
        const container = getTownContainerStub(this.env, this.townId);
        await container.setEnvVar('KILOCODE_TOKEN', token);
        console.log(`${TOWN_LOG} configureRig: stored KILOCODE_TOKEN on TownContainerDO`);
      } catch (err) {
        console.warn(`${TOWN_LOG} configureRig: failed to store token on container DO:`, err);
      }
    }

    console.log(`${TOWN_LOG} configureRig: proactively starting container`);
    await this.armAlarmIfNeeded();
    try {
      const container = getTownContainerStub(this.env, this.townId);
      await container.fetch('http://container/health');
    } catch {
      // Container may take a moment to start — the alarm will retry
    }
  }

  async getRigConfig(rigId: string): Promise<RigConfig | null> {
    return (await this.ctx.storage.get<RigConfig>(`rig:${rigId}:config`)) ?? null;
  }

  // ══════════════════════════════════════════════════════════════════
  // Beads
  // ══════════════════════════════════════════════════════════════════

  async createBead(input: CreateBeadInput): Promise<Bead> {
    return beadOps.createBead(this.db, input);
  }

  async getBeadAsync(beadId: string): Promise<Bead | null> {
    return beadOps.getBead(this.db, beadId);
  }

  async listBeads(filter: BeadFilter): Promise<Bead[]> {
    return beadOps.listBeads(this.db, filter);
  }

  async updateBeadStatus(beadId: string, status: string, agentId: string): Promise<Bead> {
    const validStatus = BeadStatus.parse(status);
    const bead = beadOps.updateBeadStatus(this.db, beadId, validStatus, agentId);

    // If closed and part of a convoy (via bead_dependencies), notify
    if (status === 'closed') {
      const convoyRows = this.db
        .select({ depends_on_bead_id: bead_dependencies.depends_on_bead_id })
        .from(bead_dependencies)
        .where(
          and(
            eq(bead_dependencies.bead_id, beadId),
            eq(bead_dependencies.dependency_type, 'tracks')
          )
        )
        .all();
      for (const { depends_on_bead_id } of convoyRows) {
        this.onBeadClosed({ convoyId: depends_on_bead_id, beadId }).catch(() => {});
      }
    }

    return bead;
  }

  async closeBead(beadId: string, agentId: string): Promise<Bead> {
    return this.updateBeadStatus(beadId, 'closed', agentId);
  }

  async deleteBead(beadId: string): Promise<void> {
    beadOps.deleteBead(this.db, beadId);
  }

  async listBeadEvents(options: {
    beadId?: string;
    since?: string;
    limit?: number;
  }): Promise<BeadEventRecord[]> {
    return beadOps.listBeadEvents(this.db, options);
  }

  // ══════════════════════════════════════════════════════════════════
  // Agents
  // ══════════════════════════════════════════════════════════════════

  async registerAgent(input: RegisterAgentInput): Promise<Agent> {
    return agents.registerAgent(this.db, input);
  }

  async getAgentAsync(agentId: string): Promise<Agent | null> {
    return agents.getAgent(this.db, agentId);
  }

  async getAgentByIdentity(identity: string): Promise<Agent | null> {
    return agents.getAgentByIdentity(this.db, identity);
  }

  async listAgents(filter?: AgentFilter): Promise<Agent[]> {
    return agents.listAgents(this.db, filter);
  }

  async updateAgentStatus(agentId: string, status: string): Promise<void> {
    agents.updateAgentStatus(this.db, agentId, status);
  }

  async deleteAgent(agentId: string): Promise<void> {
    agents.deleteAgent(this.db, agentId);
    try {
      const agentDO = getAgentDOStub(this.env, agentId);
      await agentDO.destroy();
    } catch {
      // Best-effort
    }
  }

  async hookBead(agentId: string, beadId: string): Promise<void> {
    agents.hookBead(this.db, agentId, beadId);
    await this.armAlarmIfNeeded();
  }

  async unhookBead(agentId: string): Promise<void> {
    agents.unhookBead(this.db, agentId);
  }

  async getHookedBead(agentId: string): Promise<Bead | null> {
    return agents.getHookedBead(this.db, agentId);
  }

  async getOrCreateAgent(role: AgentRole, rigId: string): Promise<Agent> {
    return agents.getOrCreateAgent(this.db, role, rigId, this.townId);
  }

  // ── Agent Events (delegated to AgentDO) ───────────────────────────

  async appendAgentEvent(agentId: string, eventType: string, data: unknown): Promise<number> {
    const agentDO = getAgentDOStub(this.env, agentId);
    return agentDO.appendEvent(eventType, data);
  }

  async getAgentEvents(agentId: string, afterId?: number, limit?: number): Promise<unknown[]> {
    const agentDO = getAgentDOStub(this.env, agentId);
    return agentDO.getEvents(afterId, limit);
  }

  // ── Prime & Checkpoint ────────────────────────────────────────────

  async prime(agentId: string): Promise<PrimeContext> {
    return agents.prime(this.db, agentId);
  }

  async writeCheckpoint(agentId: string, data: unknown): Promise<void> {
    agents.writeCheckpoint(this.db, agentId, data);
  }

  async readCheckpoint(agentId: string): Promise<unknown> {
    return agents.readCheckpoint(this.db, agentId);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────

  async touchAgentHeartbeat(agentId: string): Promise<void> {
    agents.touchAgent(this.db, agentId);
    await this.armAlarmIfNeeded();
  }

  // ══════════════════════════════════════════════════════════════════
  // Mail
  // ══════════════════════════════════════════════════════════════════

  async sendMail(input: SendMailInput): Promise<void> {
    mail.sendMail(this.db, input);
  }

  async checkMail(agentId: string): Promise<Mail[]> {
    return mail.checkMail(this.db, agentId);
  }

  // ══════════════════════════════════════════════════════════════════
  // Review Queue & Molecules
  // ══════════════════════════════════════════════════════════════════

  async submitToReviewQueue(input: ReviewQueueInput): Promise<void> {
    reviewQueue.submitToReviewQueue(this.db, input);
    await this.armAlarmIfNeeded();
  }

  async popReviewQueue(): Promise<ReviewQueueEntry | null> {
    return reviewQueue.popReviewQueue(this.db);
  }

  async completeReview(entryId: string, status: 'merged' | 'failed'): Promise<void> {
    reviewQueue.completeReview(this.db, entryId, status);
  }

  async completeReviewWithResult(input: {
    entry_id: string;
    status: 'merged' | 'failed' | 'conflict';
    message?: string;
    commit_sha?: string;
  }): Promise<void> {
    reviewQueue.completeReviewWithResult(this.db, input);
  }

  async agentDone(agentId: string, input: AgentDoneInput): Promise<void> {
    reviewQueue.agentDone(this.db, agentId, input);
    await this.armAlarmIfNeeded();
  }

  async agentCompleted(
    agentId: string,
    input: { status: 'completed' | 'failed'; reason?: string }
  ): Promise<void> {
    let resolvedAgentId = agentId;
    if (!resolvedAgentId) {
      const mayor = agents.listAgents(this.db, { role: 'mayor' })[0];
      if (mayor) resolvedAgentId = mayor.id;
    }
    if (resolvedAgentId) {
      reviewQueue.agentCompleted(this.db, resolvedAgentId, input);
    }
  }

  async createMolecule(beadId: string, formula: unknown): Promise<Molecule> {
    return reviewQueue.createMolecule(this.db, beadId, formula);
  }

  async getMoleculeCurrentStep(
    agentId: string
  ): Promise<{ molecule: Molecule; step: unknown } | null> {
    return reviewQueue.getMoleculeCurrentStep(this.db, agentId);
  }

  async advanceMoleculeStep(agentId: string, summary: string): Promise<Molecule | null> {
    return reviewQueue.advanceMoleculeStep(this.db, agentId, summary);
  }

  // ══════════════════════════════════════════════════════════════════
  // Atomic Sling (create bead + agent + hook)
  // ══════════════════════════════════════════════════════════════════

  async slingBead(input: {
    rigId: string;
    title: string;
    body?: string;
    priority?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ bead: Bead; agent: Agent }> {
    const createdBead = beadOps.createBead(this.db, {
      type: 'issue',
      title: input.title,
      body: input.body,
      priority: BeadPriority.catch('medium').parse(input.priority ?? 'medium'),
      rig_id: input.rigId,
      metadata: input.metadata,
    });

    const agent = agents.getOrCreateAgent(this.db, 'polecat', input.rigId, this.townId);
    agents.hookBead(this.db, agent.id, createdBead.bead_id);

    // Re-read bead and agent after hook (hookBead updates both)
    const bead = beadOps.getBead(this.db, createdBead.bead_id) ?? createdBead;
    const hookedAgent = agents.getAgent(this.db, agent.id) ?? agent;

    // Fire-and-forget dispatch so the sling call returns immediately.
    // The alarm loop retries if this fails.
    this.dispatchAgent(hookedAgent, bead).catch(err =>
      console.error(`${TOWN_LOG} slingBead: fire-and-forget dispatchAgent failed:`, err)
    );
    await this.armAlarmIfNeeded();
    return { bead, agent: hookedAgent };
  }

  // ══════════════════════════════════════════════════════════════════
  // Mayor (just another agent)
  // ══════════════════════════════════════════════════════════════════

  async sendMayorMessage(
    message: string,
    model?: string
  ): Promise<{ agentId: string; sessionStatus: 'idle' | 'active' | 'starting' }> {
    const townId = this.townId;

    let mayor = agents.listAgents(this.db, { role: 'mayor' })[0] ?? null;
    if (!mayor) {
      const identity = `mayor-${townId.slice(0, 8)}`;
      mayor = agents.registerAgent(this.db, {
        role: 'mayor',
        name: 'mayor',
        identity,
      });
    }

    const containerStatus = await dispatch.checkAgentContainerStatus(this.env, townId, mayor.id);
    const isAlive = containerStatus.status === 'running' || containerStatus.status === 'starting';

    console.log(
      `${TOWN_LOG} sendMayorMessage: townId=${townId} mayorId=${mayor.id} containerStatus=${containerStatus.status} isAlive=${isAlive}`
    );

    let sessionStatus: 'idle' | 'active' | 'starting';

    if (isAlive) {
      const sent = await dispatch.sendMessageToAgent(this.env, townId, mayor.id, message);
      sessionStatus = sent ? 'active' : 'idle';
    } else {
      const townConfig = await this.getTownConfig();
      const rigConfig = await this.getMayorRigConfig();
      const kilocodeToken = await this.resolveKilocodeToken();

      console.log(
        `${TOWN_LOG} sendMayorMessage: townId=${townId} hasRigConfig=${!!rigConfig} hasKilocodeToken=${!!kilocodeToken} townConfigToken=${!!townConfig.kilocode_token} rigConfigToken=${!!rigConfig?.kilocodeToken}`
      );

      if (kilocodeToken) {
        try {
          const containerStub = getTownContainerStub(this.env, townId);
          await containerStub.setEnvVar('KILOCODE_TOKEN', kilocodeToken);
        } catch {
          // Best effort
        }
      }

      const started = await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
        townId,
        rigId: `mayor-${townId}`,
        userId: townConfig.owner_user_id ?? rigConfig?.userId ?? townId,
        agentId: mayor.id,
        agentName: 'mayor',
        role: 'mayor',
        identity: mayor.identity,
        beadId: '',
        beadTitle: message,
        beadBody: '',
        checkpoint: null,
        gitUrl: rigConfig?.gitUrl ?? '',
        defaultBranch: rigConfig?.defaultBranch ?? 'main',
        kilocodeToken,
        townConfig,
      });

      if (started) {
        agents.updateAgentStatus(this.db, mayor.id, 'working');
        sessionStatus = 'starting';
      } else {
        sessionStatus = 'idle';
      }
    }

    await this.armAlarmIfNeeded();
    return { agentId: mayor.id, sessionStatus };
  }

  /**
   * Ensure the mayor agent exists and its container is running.
   * Called eagerly on page load so the terminal is available immediately
   * without requiring the user to send a message first.
   */
  async ensureMayor(): Promise<{ agentId: string; sessionStatus: 'idle' | 'active' | 'starting' }> {
    const townId = this.townId;

    let mayor = agents.listAgents(this.db, { role: 'mayor' })[0] ?? null;
    if (!mayor) {
      const identity = `mayor-${townId.slice(0, 8)}`;
      mayor = agents.registerAgent(this.db, {
        role: 'mayor',
        name: 'mayor',
        identity,
      });
      console.log(`${TOWN_LOG} ensureMayor: created mayor agent ${mayor.id}`);
    }

    // Check if the container is already running
    const containerStatus = await dispatch.checkAgentContainerStatus(this.env, townId, mayor.id);
    const isAlive = containerStatus.status === 'running' || containerStatus.status === 'starting';

    if (isAlive) {
      const status = mayor.status === 'working' || mayor.status === 'stalled' ? 'active' : 'idle';
      return { agentId: mayor.id, sessionStatus: status };
    }

    // Start the container with an idle mayor (no initial prompt)
    const townConfig = await this.getTownConfig();
    const rigConfig = await this.getMayorRigConfig();
    const kilocodeToken = await this.resolveKilocodeToken();

    // Don't start without a kilocode token — the session would use the
    // default free model and have no provider credentials. The frontend
    // will retry via status polling once a rig is created and the token
    // becomes available.
    if (!kilocodeToken) {
      console.warn(`${TOWN_LOG} ensureMayor: no kilocodeToken available, deferring start`);
      return { agentId: mayor.id, sessionStatus: 'idle' };
    }

    try {
      const containerStub = getTownContainerStub(this.env, townId);
      await containerStub.setEnvVar('KILOCODE_TOKEN', kilocodeToken);
    } catch {
      // Best effort
    }

    // Start with an empty prompt — the mayor will be idle but its container
    // and SDK server will be running, ready for PTY connections.
    const started = await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
      townId,
      rigId: `mayor-${townId}`,
      userId: townConfig.owner_user_id ?? rigConfig?.userId ?? '',
      agentId: mayor.id,
      agentName: 'mayor',
      role: 'mayor',
      identity: mayor.identity,
      beadId: '',
      beadTitle: 'Mayor ready. Waiting for instructions.',
      beadBody: '',
      checkpoint: null,
      gitUrl: rigConfig?.gitUrl ?? '',
      defaultBranch: rigConfig?.defaultBranch ?? 'main',
      kilocodeToken,
      townConfig,
    });

    if (started) {
      agents.updateAgentStatus(this.db, mayor.id, 'working');
      return { agentId: mayor.id, sessionStatus: 'starting' };
    }

    return { agentId: mayor.id, sessionStatus: 'idle' };
  }

  async getMayorStatus(): Promise<{
    configured: boolean;
    townId: string;
    session: {
      agentId: string;
      sessionId: string;
      status: 'idle' | 'active' | 'starting';
      lastActivityAt: string;
    } | null;
  }> {
    const mayor = agents.listAgents(this.db, { role: 'mayor' })[0] ?? null;

    const mapStatus = (agentStatus: string): 'idle' | 'active' | 'starting' => {
      switch (agentStatus) {
        case 'working':
          return 'active';
        case 'stalled':
          return 'active';
        default:
          return 'idle';
      }
    };

    return {
      configured: true,
      townId: this.townId,
      session: mayor
        ? {
            agentId: mayor.id,
            sessionId: mayor.id,
            status: mapStatus(mayor.status),
            lastActivityAt: mayor.last_activity_at ?? mayor.created_at,
          }
        : null,
    };
  }

  private async getMayorRigConfig(): Promise<RigConfig | null> {
    const rigList = rigs.listRigs(this.db);
    if (rigList.length === 0) return null;
    return this.getRigConfig(rigList[0].id);
  }

  private async resolveKilocodeToken(): Promise<string | undefined> {
    const townConfig = await this.getTownConfig();
    if (townConfig.kilocode_token) return townConfig.kilocode_token;

    const rigList = rigs.listRigs(this.db);
    for (const rig of rigList) {
      const rc = await this.getRigConfig(rig.id);
      if (rc?.kilocodeToken) {
        await this.updateTownConfig({ kilocode_token: rc.kilocodeToken });
        return rc.kilocodeToken;
      }
    }

    return undefined;
  }

  // ══════════════════════════════════════════════════════════════════
  // Convoys (beads with type='convoy' + convoy_metadata + bead_dependencies)
  // ══════════════════════════════════════════════════════════════════

  async createConvoy(input: {
    title: string;
    beads: Array<{ bead_id: string; rig_id: string }>;
    created_by?: string;
  }): Promise<ConvoyEntry> {
    const parsed = z
      .object({
        title: z.string().min(1),
        beads: z.array(z.object({ bead_id: z.string().min(1), rig_id: z.string().min(1) })).min(1),
        created_by: z.string().min(1).optional(),
      })
      .parse(input);

    const convoyId = generateId();
    const timestamp = now();

    // Create the convoy bead
    this.db
      .insert(beads)
      .values({
        bead_id: convoyId,
        type: 'convoy',
        status: 'open',
        title: parsed.title,
        body: null,
        rig_id: null,
        parent_bead_id: null,
        assignee_agent_bead_id: null,
        priority: 'medium',
        labels: JSON.stringify(['gt:convoy']),
        metadata: '{}',
        created_by: parsed.created_by ?? null,
        created_at: timestamp,
        updated_at: timestamp,
        closed_at: null,
      })
      .run();

    // Create convoy_metadata
    this.db
      .insert(convoy_metadata)
      .values({
        bead_id: convoyId,
        total_beads: parsed.beads.length,
        closed_beads: 0,
        landed_at: null,
      })
      .run();

    // Track beads via bead_dependencies
    for (const bead of parsed.beads) {
      this.db
        .insert(bead_dependencies)
        .values({
          bead_id: bead.bead_id,
          depends_on_bead_id: convoyId,
          dependency_type: 'tracks',
        })
        .run();
    }

    const convoy = this.getConvoy(convoyId);
    if (!convoy) throw new Error('Failed to create convoy');
    return convoy;
  }

  async onBeadClosed(input: { convoyId: string; beadId: string }): Promise<ConvoyEntry | null> {
    // Count closed tracked beads
    const closedResult = this.db
      .select({ count: count() })
      .from(bead_dependencies)
      .innerJoin(beads, eq(bead_dependencies.bead_id, beads.bead_id))
      .where(
        and(
          eq(bead_dependencies.depends_on_bead_id, input.convoyId),
          eq(bead_dependencies.dependency_type, 'tracks'),
          eq(beads.status, 'closed')
        )
      )
      .get();
    const closedCount = closedResult?.count ?? 0;

    this.db
      .update(convoy_metadata)
      .set({ closed_beads: closedCount })
      .where(eq(convoy_metadata.bead_id, input.convoyId))
      .run();

    const convoy = this.getConvoy(input.convoyId);
    if (convoy && convoy.status === 'active' && convoy.closed_beads >= convoy.total_beads) {
      const timestamp = now();
      this.db
        .update(beads)
        .set({ status: 'closed', closed_at: timestamp, updated_at: timestamp })
        .where(eq(beads.bead_id, input.convoyId))
        .run();
      this.db
        .update(convoy_metadata)
        .set({ landed_at: timestamp })
        .where(eq(convoy_metadata.bead_id, input.convoyId))
        .run();
      return this.getConvoy(input.convoyId);
    }
    return convoy;
  }

  private getConvoy(convoyId: string): ConvoyEntry | null {
    const row = this.db
      .select(convoyJoinColumns)
      .from(beads)
      .innerJoin(convoy_metadata, eq(beads.bead_id, convoy_metadata.bead_id))
      .where(eq(beads.bead_id, convoyId))
      .get();
    if (!row) return null;
    return toConvoy(row);
  }

  // ══════════════════════════════════════════════════════════════════
  // Escalations (beads with type='escalation' + escalation_metadata)
  // ══════════════════════════════════════════════════════════════════

  async acknowledgeEscalation(escalationId: string): Promise<EscalationEntry | null> {
    this.db
      .update(escalation_metadata)
      .set({ acknowledged: 1, acknowledged_at: now() })
      .where(
        and(eq(escalation_metadata.bead_id, escalationId), eq(escalation_metadata.acknowledged, 0))
      )
      .run();
    return this.getEscalation(escalationId);
  }

  async listEscalations(filter?: { acknowledged?: boolean }): Promise<EscalationEntry[]> {
    const conditions: SQL[] = [];
    if (filter?.acknowledged !== undefined) {
      conditions.push(eq(escalation_metadata.acknowledged, filter.acknowledged ? 1 : 0));
    }

    const q = this.db
      .select(escalationJoinColumns)
      .from(beads)
      .innerJoin(escalation_metadata, eq(beads.bead_id, escalation_metadata.bead_id));

    const rows = (conditions.length > 0 ? q.where(and(...conditions)) : q)
      .orderBy(desc(beads.created_at))
      .limit(100)
      .all();

    return rows.map(toEscalation);
  }

  async routeEscalation(input: {
    townId: string;
    source_rig_id: string;
    source_agent_id?: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    category?: string;
    message: string;
  }): Promise<EscalationEntry> {
    const beadId = generateId();
    const timestamp = now();

    // Create the escalation bead
    this.db
      .insert(beads)
      .values({
        bead_id: beadId,
        type: 'escalation',
        status: 'open',
        title: `Escalation: ${input.message.slice(0, 100)}`,
        body: input.message,
        rig_id: input.source_rig_id,
        parent_bead_id: null,
        assignee_agent_bead_id: null,
        priority:
          input.severity === 'critical'
            ? 'critical'
            : input.severity === 'high'
              ? 'high'
              : 'medium',
        labels: JSON.stringify(['gt:escalation', `severity:${input.severity}`]),
        metadata: '{}',
        created_by: input.source_agent_id ?? null,
        created_at: timestamp,
        updated_at: timestamp,
        closed_at: null,
      })
      .run();

    // Create escalation_metadata
    this.db
      .insert(escalation_metadata)
      .values({
        bead_id: beadId,
        severity: input.severity,
        category: input.category ?? null,
        acknowledged: 0,
        re_escalation_count: 0,
        acknowledged_at: null,
      })
      .run();

    const escalation = this.getEscalation(beadId);
    if (!escalation) throw new Error('Failed to create escalation');

    // Notify mayor for medium+ severity
    if (input.severity !== 'low') {
      this.sendMayorMessage(
        `[Escalation:${input.severity}] rig=${input.source_rig_id} ${input.message}`
      ).catch(err => {
        console.warn(`${TOWN_LOG} routeEscalation: failed to notify mayor:`, err);
        try {
          beadOps.logBeadEvent(this.db, {
            beadId,
            agentId: input.source_agent_id ?? null,
            eventType: 'notification_failed',
            metadata: {
              target: 'mayor',
              reason: err instanceof Error ? err.message : String(err),
              severity: input.severity,
            },
          });
        } catch (logErr) {
          console.error(
            `${TOWN_LOG} routeEscalation: failed to log notification_failed event:`,
            logErr
          );
        }
      });
    }

    return escalation;
  }

  private getEscalation(escalationId: string): EscalationEntry | null {
    const row = this.db
      .select(escalationJoinColumns)
      .from(beads)
      .innerJoin(escalation_metadata, eq(beads.bead_id, escalation_metadata.bead_id))
      .where(eq(beads.bead_id, escalationId))
      .get();
    if (!row) return null;
    return toEscalation(row);
  }

  // ══════════════════════════════════════════════════════════════════
  // Alarm (Scheduler + Witness Patrol + Review Queue)
  // ══════════════════════════════════════════════════════════════════

  async alarm(): Promise<void> {
    const townId = this.townId;
    console.log(`${TOWN_LOG} alarm: fired for town=${townId}`);

    const hasRigs = rigs.listRigs(this.db).length > 0;
    if (hasRigs) {
      try {
        await this.ensureContainerReady();
      } catch (err) {
        console.warn(`${TOWN_LOG} alarm: container health check failed`, err);
      }
    }

    try {
      await this.schedulePendingWork();
    } catch (err) {
      console.error(`${TOWN_LOG} alarm: schedulePendingWork failed`, err);
    }
    try {
      await this.witnessPatrol();
    } catch (err) {
      console.error(`${TOWN_LOG} alarm: witnessPatrol failed`, err);
    }
    try {
      await this.deliverPendingMail();
    } catch (err) {
      console.warn(`${TOWN_LOG} alarm: deliverPendingMail failed`, err);
    }
    try {
      await this.processReviewQueue();
    } catch (err) {
      console.error(`${TOWN_LOG} alarm: processReviewQueue failed`, err);
    }
    try {
      await this.reEscalateStaleEscalations();
    } catch (err) {
      console.warn(`${TOWN_LOG} alarm: reEscalation failed`, err);
    }

    // Re-arm: fast when active, slow when idle
    const active = this.hasActiveWork();
    const interval = active ? ACTIVE_ALARM_INTERVAL_MS : IDLE_ALARM_INTERVAL_MS;
    await this.ctx.storage.setAlarm(Date.now() + interval);
  }

  private hasActiveWork(): boolean {
    const active = this.db
      .select({ cnt: count() })
      .from(agent_metadata)
      .where(inArray(agent_metadata.status, ['working', 'stalled']))
      .get();
    const pending = this.db
      .select({ cnt: count() })
      .from(agent_metadata)
      .where(and(eq(agent_metadata.status, 'idle'), isNotNull(agent_metadata.current_hook_bead_id)))
      .get();
    const reviews = this.db
      .select({ cnt: count() })
      .from(beads)
      .where(and(eq(beads.type, 'merge_request'), inArray(beads.status, ['open', 'in_progress'])))
      .get();
    return (active?.cnt ?? 0) > 0 || (pending?.cnt ?? 0) > 0 || (reviews?.cnt ?? 0) > 0;
  }

  /**
   * Dispatch a single agent to the container. Used for eager dispatch from
   * slingBead (so agents start immediately) and from schedulePendingWork
   * (periodic recovery). Returns true if the agent was started.
   */
  private async dispatchAgent(agent: Agent, bead: Bead): Promise<boolean> {
    try {
      const rigId = agent.rig_id ?? rigs.listRigs(this.db)[0]?.id ?? '';
      const rigConfig = rigId ? await this.getRigConfig(rigId) : null;
      if (!rigConfig) {
        console.warn(`${TOWN_LOG} dispatchAgent: no rig config for agent=${agent.id} rig=${rigId}`);
        return false;
      }

      const townConfig = await this.getTownConfig();
      const kilocodeToken = await this.resolveKilocodeToken();

      // Mark dispatch in progress: set last_activity_at so schedulePendingWork
      // skips this agent while the container start is in flight, and bump
      // dispatch_attempts for the retry budget.
      this.db
        .update(agent_metadata)
        .set({
          dispatch_attempts: sql`${agent_metadata.dispatch_attempts} + 1`,
          last_activity_at: now(),
        })
        .where(eq(agent_metadata.bead_id, agent.id))
        .run();

      const started = await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
        townId: this.townId,
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
      });

      if (started) {
        this.db
          .update(agent_metadata)
          .set({
            status: 'working',
            dispatch_attempts: 0,
            last_activity_at: now(),
          })
          .where(eq(agent_metadata.bead_id, agent.id))
          .run();
        console.log(`${TOWN_LOG} dispatchAgent: started agent=${agent.name}(${agent.id})`);
      }
      return started;
    } catch (err) {
      console.error(`${TOWN_LOG} dispatchAgent: failed for agent=${agent.id}:`, err);
      return false;
    }
  }

  /**
   * Find idle agents with hooked beads and dispatch them to the container.
   * Agents whose last_activity_at is within the dispatch cooldown are
   * skipped — they have a fire-and-forget dispatch already in flight.
   */
  private async schedulePendingWork(): Promise<void> {
    const cooldownCutoff = new Date(Date.now() - DISPATCH_COOLDOWN_MS).toISOString();

    // Exclude beads.status from the join columns since agent_metadata.status
    // shadows it and we need the agent status, not the bead status.
    const { status: _beadStatus, ...beadCols } = getTableColumns(beads);
    const pendingAgentColumns = {
      ...beadCols,
      role: agent_metadata.role,
      identity: agent_metadata.identity,
      container_process_id: agent_metadata.container_process_id,
      status: agent_metadata.status,
      current_hook_bead_id: agent_metadata.current_hook_bead_id,
      dispatch_attempts: agent_metadata.dispatch_attempts,
      last_activity_at: agent_metadata.last_activity_at,
      checkpoint: agent_metadata.checkpoint,
    };

    const rows = this.db
      .select(pendingAgentColumns)
      .from(beads)
      .innerJoin(agent_metadata, eq(beads.bead_id, agent_metadata.bead_id))
      .where(
        and(
          eq(agent_metadata.status, 'idle'),
          isNotNull(agent_metadata.current_hook_bead_id),
          or(
            isNull(agent_metadata.last_activity_at),
            sql`${agent_metadata.last_activity_at} < ${cooldownCutoff}`
          )
        )
      )
      .all();

    const pendingAgents: Agent[] = rows.map(row => ({
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
    }));

    console.log(`${TOWN_LOG} schedulePendingWork: found ${pendingAgents.length} pending agents`);
    if (pendingAgents.length === 0) return;

    const dispatchTasks: Array<() => Promise<void>> = [];

    for (const agent of pendingAgents) {
      const beadId = agent.current_hook_bead_id;
      if (!beadId) continue;
      const bead = beadOps.getBead(this.db, beadId);
      if (!bead) continue;

      if (agent.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS) {
        beadOps.updateBeadStatus(this.db, beadId, 'failed', agent.id);
        agents.unhookBead(this.db, agent.id);
        continue;
      }

      dispatchTasks.push(async () => {
        await this.dispatchAgent(agent, bead);
      });
    }

    if (dispatchTasks.length > 0) {
      await Promise.allSettled(dispatchTasks.map(fn => fn()));
    }
  }

  /**
   * Witness patrol: detect dead/stale agents, orphaned beads.
   */
  private async witnessPatrol(): Promise<void> {
    const townId = this.townId;
    const guppThreshold = new Date(Date.now() - GUPP_THRESHOLD_MS).toISOString();

    const workingAgents = this.db
      .select({
        bead_id: agent_metadata.bead_id,
        current_hook_bead_id: agent_metadata.current_hook_bead_id,
        last_activity_at: agent_metadata.last_activity_at,
      })
      .from(agent_metadata)
      .where(inArray(agent_metadata.status, ['working', 'stalled']))
      .all();

    for (const working of workingAgents) {
      const agentId = working.bead_id;
      const hookBeadId = working.current_hook_bead_id;
      const lastActivity = working.last_activity_at;

      const containerInfo = await dispatch.checkAgentContainerStatus(this.env, townId, agentId);

      if (containerInfo.status === 'not_found' || containerInfo.status === 'exited') {
        if (containerInfo.exitReason === 'completed') {
          reviewQueue.agentCompleted(this.db, agentId, { status: 'completed' });
          continue;
        }
        this.db
          .update(agent_metadata)
          .set({ status: 'idle', last_activity_at: now() })
          .where(eq(agent_metadata.bead_id, agentId))
          .run();
        continue;
      }

      // GUPP violation check
      if (lastActivity && lastActivity < guppThreshold) {
        // Check for existing GUPP mail
        const existingGupp = this.db
          .select({ bead_id: beads.bead_id })
          .from(beads)
          .where(
            and(
              eq(beads.type, 'message'),
              eq(beads.assignee_agent_bead_id, agentId),
              eq(beads.title, 'GUPP_CHECK'),
              eq(beads.status, 'open')
            )
          )
          .limit(1)
          .all();
        if (existingGupp.length === 0) {
          mail.sendMail(this.db, {
            from_agent_id: 'witness',
            to_agent_id: agentId,
            subject: 'GUPP_CHECK',
            body: 'You have had work hooked for 30+ minutes with no activity. Are you stuck? If so, call gt_escalate.',
          });
        }
      }
    }
  }

  /**
   * Push undelivered mail to agents that are currently running in the
   * container. For each working agent with open message beads, we format
   * the messages and send them as a follow-up prompt via the container's
   * /agents/:id/message endpoint. The mail is then marked as delivered so
   * it isn't sent again on the next alarm tick.
   */
  private async deliverPendingMail(): Promise<void> {
    const pendingByAgent = mail.getPendingMailForWorkingAgents(this.db);
    if (pendingByAgent.size === 0) return;

    console.log(
      `${TOWN_LOG} deliverPendingMail: ${pendingByAgent.size} agent(s) with pending mail`
    );

    const deliveries = [...pendingByAgent.entries()].map(async ([agentId, messages]) => {
      const lines = messages.map(m => `[MAIL from ${m.from_agent_id}] ${m.subject}\n${m.body}`);
      const prompt = `You have ${messages.length} new mail message(s):\n\n${lines.join('\n\n---\n\n')}`;

      const sent = await dispatch.sendMessageToAgent(this.env, this.townId, agentId, prompt);

      if (sent) {
        // Mark delivered only after the container accepted the message
        mail.readAndDeliverMail(this.db, agentId);
        console.log(
          `${TOWN_LOG} deliverPendingMail: delivered ${messages.length} message(s) to agent=${agentId}`
        );
      } else {
        console.warn(
          `${TOWN_LOG} deliverPendingMail: failed to push mail to agent=${agentId}, will retry next tick`
        );
      }
    });

    await Promise.allSettled(deliveries);
  }

  /**
   * Process the review queue: pop pending entries and trigger merge.
   */
  private async processReviewQueue(): Promise<void> {
    reviewQueue.recoverStuckReviews(this.db);

    const entry = reviewQueue.popReviewQueue(this.db);
    if (!entry) return;

    // Resolve rig from the merge_request bead — not rigList[0] which would
    // pick the wrong rig in multi-rig towns.
    const rigId = entry.rig_id;
    if (!rigId) {
      console.error(`${TOWN_LOG} processReviewQueue: entry ${entry.id} has no rig_id, skipping`);
      reviewQueue.completeReview(this.db, entry.id, 'failed');
      return;
    }
    const rigConfig = await this.getRigConfig(rigId);
    if (!rigConfig) {
      reviewQueue.completeReview(this.db, entry.id, 'failed');
      return;
    }

    const townConfig = await this.getTownConfig();
    const gates = townConfig.refinery?.gates ?? [];

    if (gates.length > 0) {
      const refineryAgent = agents.getOrCreateAgent(this.db, 'refinery', rigId, this.townId);

      const { buildRefinerySystemPrompt } = await import('../prompts/refinery-system.prompt');
      const systemPrompt = buildRefinerySystemPrompt({
        identity: refineryAgent.identity,
        rigId,
        townId: this.townId,
        gates,
        branch: entry.branch,
        targetBranch: rigConfig.defaultBranch,
        polecatAgentId: entry.agent_id,
      });

      // Hook the refinery to the MR bead (entry.id), not the source bead
      // (entry.bead_id). The source bead stays closed with its original
      // polecat assignee preserved.
      agents.hookBead(this.db, refineryAgent.id, entry.id);

      const started = await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
        townId: this.townId,
        rigId,
        userId: rigConfig.userId,
        agentId: refineryAgent.id,
        agentName: refineryAgent.name,
        role: 'refinery',
        identity: refineryAgent.identity,
        beadId: entry.id,
        beadTitle: `Review merge: ${entry.branch} → ${rigConfig.defaultBranch}`,
        beadBody: entry.summary ?? '',
        checkpoint: null,
        gitUrl: rigConfig.gitUrl,
        defaultBranch: rigConfig.defaultBranch,
        kilocodeToken: rigConfig.kilocodeToken,
        townConfig,
        systemPromptOverride: systemPrompt,
        platformIntegrationId: rigConfig.platformIntegrationId,
      });

      if (!started) {
        agents.unhookBead(this.db, refineryAgent.id);
        await this.triggerDeterministicMerge(rigConfig, entry, townConfig);
      }
    } else {
      await this.triggerDeterministicMerge(rigConfig, entry, townConfig);
    }
  }

  private async triggerDeterministicMerge(
    rigConfig: RigConfig,
    entry: ReviewQueueEntry,
    townConfig: TownConfig
  ): Promise<void> {
    const ok = await dispatch.startMergeInContainer(this.env, this.ctx.storage, {
      townId: this.townId,
      rigId: rigConfig.rigId,
      agentId: entry.agent_id,
      entryId: entry.id,
      beadId: entry.bead_id,
      branch: entry.branch,
      targetBranch: rigConfig.defaultBranch,
      gitUrl: rigConfig.gitUrl,
      kilocodeToken: rigConfig.kilocodeToken,
      townConfig,
    });
    if (!ok) {
      reviewQueue.completeReview(this.db, entry.id, 'failed');
    }
  }

  /**
   * Bump severity of stale unacknowledged escalations.
   */
  private async reEscalateStaleEscalations(): Promise<void> {
    const candidates = this.db
      .select(escalationJoinColumns)
      .from(beads)
      .innerJoin(escalation_metadata, eq(beads.bead_id, escalation_metadata.bead_id))
      .where(
        and(
          eq(escalation_metadata.acknowledged, 0),
          sql`${escalation_metadata.re_escalation_count} < ${MAX_RE_ESCALATIONS}`
        )
      )
      .all()
      .map(toEscalation);

    const nowMs = Date.now();
    for (const esc of candidates) {
      const ageMs = nowMs - new Date(esc.created_at).getTime();
      const requiredAgeMs = (esc.re_escalation_count + 1) * STALE_ESCALATION_THRESHOLD_MS;
      if (ageMs < requiredAgeMs) continue;

      const currentIdx = SEVERITY_ORDER.indexOf(esc.severity);
      if (currentIdx < 0 || currentIdx >= SEVERITY_ORDER.length - 1) continue;

      const newSeverity = SEVERITY_ORDER[currentIdx + 1];
      this.db
        .update(escalation_metadata)
        .set({
          severity: newSeverity,
          re_escalation_count: sql`${escalation_metadata.re_escalation_count} + 1`,
        })
        .where(eq(escalation_metadata.bead_id, esc.id))
        .run();

      if (newSeverity !== 'low') {
        this.sendMayorMessage(
          `[Re-Escalation:${newSeverity}] rig=${esc.source_rig_id} ${esc.message}`
        ).catch(err => {
          console.warn(`${TOWN_LOG} re-escalation: failed to notify mayor:`, err);
          try {
            beadOps.logBeadEvent(this.db, {
              beadId: esc.id,
              agentId: null,
              eventType: 'notification_failed',
              metadata: {
                target: 'mayor',
                reason: err instanceof Error ? err.message : String(err),
                severity: newSeverity,
                re_escalation: true,
              },
            });
          } catch (logErr) {
            console.error(
              `${TOWN_LOG} re-escalation: failed to log notification_failed event:`,
              logErr
            );
          }
        });
      }
    }
  }

  private async ensureContainerReady(): Promise<void> {
    const hasRigs = rigs.listRigs(this.db).length > 0;
    if (!hasRigs) return;

    const hasWork = this.hasActiveWork();
    if (!hasWork) {
      const rigList = rigs.listRigs(this.db);
      const newestRigAge = rigList.reduce((min, r) => {
        const age = Date.now() - new Date(r.created_at).getTime();
        return Math.min(min, age);
      }, Infinity);
      const isRecentlyConfigured = newestRigAge < 5 * 60_000;
      if (!isRecentlyConfigured) return;
    }

    const townId = this.townId;
    if (!townId) return;

    try {
      const container = getTownContainerStub(this.env, townId);
      await container.fetch('http://container/health');
    } catch {
      // Container is starting up or unavailable — alarm will retry
    }
  }

  // ── Alarm helpers ─────────────────────────────────────────────────

  private async armAlarmIfNeeded(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (!current || current < Date.now()) {
      await this.ctx.storage.setAlarm(Date.now() + ACTIVE_ALARM_INTERVAL_MS);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Cleanup
  // ══════════════════════════════════════════════════════════════════

  async destroy(): Promise<void> {
    console.log(`${TOWN_LOG} destroy: clearing all storage and alarms`);

    try {
      const allAgents = agents.listAgents(this.db);
      await Promise.allSettled(
        allAgents.map(agent => getAgentDOStub(this.env, agent.id).destroy())
      );
    } catch {
      // Best-effort
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export function getTownDOStub(env: Env, townId: string) {
  return env.TOWN.get(env.TOWN.idFromName(townId));
}
