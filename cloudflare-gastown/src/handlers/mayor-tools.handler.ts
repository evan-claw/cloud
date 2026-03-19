import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { getGastownUserStub } from '../dos/GastownUser.do';
import { getGastownOrgStub } from '../dos/GastownOrg.do';
import { withDORetry } from '@kilocode/worker-utils';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import {
  BeadStatus,
  BeadType,
  BeadPriority,
  UiActionSchema,
  normalizeUiAction,
  uiActionRigId,
} from '../types';
import type { GastownEnv } from '../gastown.worker';

const HANDLER_LOG = '[mayor-tools.handler]';

// ── Schemas ──────────────────────────────────────────────────────────────

const MayorSlingBody = z.object({
  rig_id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const MayorSlingBatchBody = z
  .object({
    rig_id: z.string().min(1),
    convoy_title: z.string().min(1),
    tasks: z
      .array(
        z.object({
          title: z.string().min(1),
          body: z.string().optional(),
          depends_on: z.array(z.number().int().min(0)).optional(),
        })
      )
      .min(1)
      .max(50),
    merge_mode: z.enum(['review-then-land', 'review-and-merge']).optional(),
    /** Set to true only when ALL tasks are genuinely independent (no shared files, no shared state). */
    parallel: z.boolean().optional(),
    staged: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    // Require dependency graph unless explicitly opted out with parallel: true.
    // Without depends_on, all polecats start simultaneously on the same codebase
    // and produce merge conflicts.
    if (data.parallel) return;
    if (data.tasks.length <= 1) return;
    const hasDeps = data.tasks.some(t => t.depends_on && t.depends_on.length > 0);
    if (!hasDeps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Convoy has multiple tasks but none declare depends_on. ' +
          'Without dependencies, all polecats start at the same time on the same codebase and will produce merge conflicts. ' +
          'Add depends_on to express task ordering, or set parallel: true if ALL tasks are genuinely independent ' +
          '(they touch completely different files with no shared state).',
        path: ['tasks'],
      });
    }
  });

const MayorMailBody = z.object({
  rig_id: z.string().min(1),
  to_agent_id: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  from_agent_id: z.string().min(1),
});

const NonNegativeInt = z.coerce.number().int().nonnegative();

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve the userId for the mayor's town.
 *
 * In production the JWT is always present (set by mayorAuthMiddleware).
 * In development the middleware is skipped, so we fall back to a
 * `userId` query parameter to keep the routes testable.
 */
function resolveUserId(c: Context<GastownEnv>): string | null {
  const jwt = c.get('agentJWT');
  if (jwt?.userId) return jwt.userId;
  // Dev-mode fallback: accept userId as a query param
  return c.req.query('userId') ?? null;
}

/**
 * Resolve the DO stub that owns rigs for a given town. For personal towns
 * this is GastownUserDO; for org towns it's GastownOrgDO.
 */
async function resolveRigOwnerForTown(env: Env, townId: string, userId: string) {
  try {
    const config = await withDORetry(
      () => getTownDOStub(env, townId),
      stub => stub.getTownConfig(),
      'TownDO.getTownConfig(resolveRigOwner)'
    );
    if (config.owner_type === 'org' && config.organization_id) {
      return getGastownOrgStub(env, config.organization_id);
    }
  } catch {
    // Fall through to user DO
  }
  return getGastownUserStub(env, userId);
}

/**
 * Verify that `rigId` belongs to `townId` by checking the rig registry
 * (user DO for personal towns, org DO for org towns).
 */
async function verifyRigBelongsToTown(
  c: Context<GastownEnv>,
  townId: string,
  rigId: string
): Promise<boolean> {
  const userId = resolveUserId(c);
  if (!userId) return false;
  const ownerDO = await resolveRigOwnerForTown(c.env, townId, userId);
  const rig = await withDORetry(
    () => ownerDO,
    stub => stub.getRigAsync(rigId),
    'OwnerDO.getRigAsync(verifyRig)'
  );
  return rig !== null && rig.town_id === townId;
}

// ── Handlers ─────────────────────────────────────────────────────────────

/**
 * POST /api/mayor/:townId/tools/sling
 * Sling a task to a polecat in a specific rig. Creates a bead, assigns
 * an agent, and arms the alarm for dispatch.
 */
export async function handleMayorSling(c: Context<GastownEnv>, params: { townId: string }) {
  const parsed = MayorSlingBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const rigOwned = await verifyRigBelongsToTown(c, params.townId, parsed.data.rig_id);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleMayorSling: townId=${params.townId} rigId=${parsed.data.rig_id} title="${parsed.data.title.slice(0, 80)}"`
  );

  const result = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub =>
      stub.slingBead({
        rigId: parsed.data.rig_id,
        ...parsed.data,
      }),
    'TownDO.slingBead(mayorSling)'
  );

  console.log(
    `${HANDLER_LOG} handleMayorSling: completed, result=${JSON.stringify(result).slice(0, 300)}`
  );

  return c.json(resSuccess(result), 201);
}

/**
 * GET /api/mayor/:townId/tools/rigs
 * List all rigs in the town. Requires userId to route to the correct
 * GastownUserDO instance (from JWT in prod, query param in dev).
 */
export async function handleMayorListRigs(c: Context<GastownEnv>, params: { townId: string }) {
  const userId = resolveUserId(c);
  if (!userId) {
    return c.json(resError('Missing userId in token (or userId query param in dev mode)'), 401);
  }

  console.log(`${HANDLER_LOG} handleMayorListRigs: townId=${params.townId} userId=${userId}`);

  const ownerDO = await resolveRigOwnerForTown(c.env, params.townId, userId);
  const rigs = await withDORetry(
    () => ownerDO,
    stub => stub.listRigs(params.townId),
    'OwnerDO.listRigs(mayorListRigs)'
  );

  return c.json(resSuccess(rigs));
}

/**
 * GET /api/mayor/:townId/tools/rigs/:rigId/beads
 * List beads in a specific rig. Supports status and type filtering.
 */
export async function handleMayorListBeads(
  c: Context<GastownEnv>,
  params: { townId: string; rigId: string }
) {
  const rigOwned = await verifyRigBelongsToTown(c, params.townId, params.rigId);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  const limitRaw = c.req.query('limit');
  const offsetRaw = c.req.query('offset');
  const limit = limitRaw !== undefined ? NonNegativeInt.safeParse(limitRaw) : undefined;
  const offset = offsetRaw !== undefined ? NonNegativeInt.safeParse(offsetRaw) : undefined;
  if ((limit && !limit.success) || (offset && !offset.success)) {
    return c.json(resError('limit and offset must be non-negative integers'), 400);
  }

  const statusRaw = c.req.query('status');
  const typeRaw = c.req.query('type');
  const status = statusRaw !== undefined ? BeadStatus.safeParse(statusRaw) : undefined;
  const type = typeRaw !== undefined ? BeadType.safeParse(typeRaw) : undefined;
  if ((status && !status.success) || (type && !type.success)) {
    return c.json(resError('Invalid status or type filter'), 400);
  }

  console.log(
    `${HANDLER_LOG} handleMayorListBeads: townId=${params.townId} rigId=${params.rigId} status=${statusRaw ?? 'all'} type=${typeRaw ?? 'all'}`
  );

  const beads = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub =>
      stub.listBeads({
        rig_id: params.rigId,
        status: status?.data,
        type: type?.data,
        assignee_agent_bead_id:
          c.req.query('assignee_agent_bead_id') ?? c.req.query('assignee_agent_id'),
        limit: limit?.data,
        offset: offset?.data,
      }),
    'TownDO.listBeads(mayorListBeads)'
  );

  return c.json(resSuccess(beads));
}

/**
 * GET /api/mayor/:townId/tools/rigs/:rigId/agents
 * List agents in a specific rig.
 */
export async function handleMayorListAgents(
  c: Context<GastownEnv>,
  params: { townId: string; rigId: string }
) {
  const rigOwned = await verifyRigBelongsToTown(c, params.townId, params.rigId);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleMayorListAgents: townId=${params.townId} rigId=${params.rigId}`
  );

  const agents = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.listAgents({ rig_id: params.rigId }),
    'TownDO.listAgents(mayorListAgents)'
  );

  return c.json(resSuccess(agents));
}

/**
 * POST /api/mayor/:townId/tools/mail
 * Send mail to an agent in any rig. The mayor can communicate cross-rig.
 */
export async function handleMayorSendMail(c: Context<GastownEnv>, params: { townId: string }) {
  const parsed = MayorMailBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const rigOwned = await verifyRigBelongsToTown(c, params.townId, parsed.data.rig_id);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleMayorSendMail: townId=${params.townId} rigId=${parsed.data.rig_id} to=${parsed.data.to_agent_id} subject="${parsed.data.subject.slice(0, 80)}"`
  );

  await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub =>
      stub.sendMail({
        from_agent_id: parsed.data.from_agent_id,
        to_agent_id: parsed.data.to_agent_id,
        subject: parsed.data.subject,
        body: parsed.data.body,
      }),
    'TownDO.sendMail(mayorSendMail)'
  );

  return c.json(resSuccess({ sent: true }));
}

/**
 * POST /api/mayor/:townId/tools/sling-batch
 * Sling multiple beads as a tracked convoy. Creates N beads + 1 convoy,
 * assigns polecats, and dispatches all in one call.
 */
export async function handleMayorSlingBatch(c: Context<GastownEnv>, params: { townId: string }) {
  const parsed = MayorSlingBatchBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const rigOwned = await verifyRigBelongsToTown(c, params.townId, parsed.data.rig_id);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleMayorSlingBatch: townId=${params.townId} rigId=${parsed.data.rig_id} convoy="${parsed.data.convoy_title.slice(0, 80)}" tasks=${parsed.data.tasks.length}`
  );

  const result = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub =>
      stub.slingConvoy({
        rigId: parsed.data.rig_id,
        convoyTitle: parsed.data.convoy_title,
        tasks: parsed.data.tasks,
        merge_mode: parsed.data.merge_mode,
        staged: parsed.data.staged,
      }),
    'TownDO.slingConvoy(mayorSlingBatch)'
  );

  console.log(
    `${HANDLER_LOG} handleMayorSlingBatch: completed, convoy=${result.convoy.id} beads=${result.beads.length}`
  );

  return c.json(resSuccess(result), 201);
}

/**
 * GET /api/mayor/:townId/tools/convoys
 * List active convoys with progress counts.
 */
export async function handleMayorListConvoys(c: Context<GastownEnv>, params: { townId: string }) {
  console.log(`${HANDLER_LOG} handleMayorListConvoys: townId=${params.townId}`);

  const convoys = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.listConvoys(),
    'TownDO.listConvoys(mayorListConvoys)'
  );

  return c.json(resSuccess(convoys));
}

/**
 * GET /api/mayor/:townId/tools/rigs/:rigId/agents/:agentId/pending-nudges
 * Returns undelivered, non-expired nudges for the given agent.
 * Allows the mayor to inspect an agent's nudge queue and decide whether to intervene.
 */
export async function handleMayorGetPendingNudges(
  c: Context<GastownEnv>,
  params: { townId: string; rigId: string; agentId: string }
) {
  const rigOwned = await verifyRigBelongsToTown(c, params.townId, params.rigId);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleMayorGetPendingNudges: townId=${params.townId} rigId=${params.rigId} agentId=${params.agentId}`
  );

  const nudges = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.getPendingNudges(params.agentId),
    'TownDO.getPendingNudges(mayorGetPendingNudges)'
  );

  return c.json(resSuccess(nudges));
}

/**
 * GET /api/mayor/:townId/tools/convoys/:convoyId
 * Detailed convoy status with per-bead breakdown.
 */
export async function handleMayorConvoyStatus(
  c: Context<GastownEnv>,
  params: { townId: string; convoyId: string }
) {
  console.log(
    `${HANDLER_LOG} handleMayorConvoyStatus: townId=${params.townId} convoyId=${params.convoyId}`
  );

  const status = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.getConvoyStatus(params.convoyId),
    'TownDO.getConvoyStatus(mayorConvoyStatus)'
  );

  if (!status) return c.json(resError('Convoy not found'), 404);
  return c.json(resSuccess(status));
}

// ── Edit operation schemas ────────────────────────────────────────────────

const BeadUpdateBody = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().nullable().optional(),
    priority: BeadPriority.optional(),
    labels: z.array(z.string()).optional(),
    status: BeadStatus.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    rig_id: z.string().min(1).nullable().optional(),
    parent_bead_id: z.string().min(1).nullable().optional(),
  })
  .refine(
    data =>
      data.title !== undefined ||
      data.body !== undefined ||
      data.priority !== undefined ||
      data.labels !== undefined ||
      data.status !== undefined ||
      data.metadata !== undefined ||
      data.rig_id !== undefined ||
      data.parent_bead_id !== undefined,
    { message: 'At least one field must be provided' }
  );

const BeadReassignBody = z.object({
  agent_id: z.string().min(1),
});

const ConvoyUpdateBody = z
  .object({
    merge_mode: z.enum(['review-then-land', 'review-and-merge']).optional(),
    feature_branch: z.string().min(1).optional(),
  })
  .refine(data => data.merge_mode !== undefined || data.feature_branch !== undefined, {
    message: 'At least one field must be provided',
  });

// ── Edit handlers ─────────────────────────────────────────────────────────

/**
 * PATCH /api/mayor/:townId/tools/rigs/:rigId/beads/:beadId
 * Partially update a bead's editable fields (title, body, priority, labels, status, metadata).
 */
export async function handleMayorBeadUpdate(
  c: Context<GastownEnv>,
  params: { townId: string; rigId: string; beadId: string }
) {
  const rigOwned = await verifyRigBelongsToTown(c, params.townId, params.rigId);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  const parsed = BeadUpdateBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleMayorBeadUpdate: townId=${params.townId} rigId=${params.rigId} beadId=${params.beadId}`
  );

  // Verify the bead belongs to this rig (same check as handleMayorBeadDelete)
  const existing = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.getBeadAsync(params.beadId),
    'TownDO.getBeadAsync(mayorBeadUpdate)'
  );
  if (!existing) {
    return c.json(resError('Bead not found'), 404);
  }
  if (existing.rig_id !== params.rigId) {
    return c.json(resError('Bead does not belong to this rig'), 403);
  }

  const bead = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.updateBead(params.beadId, parsed.data, 'mayor'),
    'TownDO.updateBead(mayorBeadUpdate)'
  );

  return c.json(resSuccess(bead));
}

/**
 * POST /api/mayor/:townId/tools/rigs/:rigId/beads/:beadId/reassign
 * Reassign a bead to a different agent. Unhooks the current agent (if any)
 * and hooks the specified agent.
 */
export async function handleMayorBeadReassign(
  c: Context<GastownEnv>,
  params: { townId: string; rigId: string; beadId: string }
) {
  const rigOwned = await verifyRigBelongsToTown(c, params.townId, params.rigId);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  const parsed = BeadReassignBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleMayorBeadReassign: townId=${params.townId} rigId=${params.rigId} beadId=${params.beadId} targetAgent=${parsed.data.agent_id}`
  );

  const bead = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.getBeadAsync(params.beadId),
    'TownDO.getBeadAsync(mayorBeadReassign)'
  );
  if (!bead) {
    return c.json(resError('Bead not found'), 404);
  }
  if (bead.rig_id !== params.rigId) {
    return c.json(resError('Bead does not belong to this rig'), 403);
  }

  // Validate target agent belongs to this rig
  const targetAgent = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.getAgentAsync(parsed.data.agent_id),
    'TownDO.getAgentAsync(mayorBeadReassign)'
  );
  if (!targetAgent) {
    return c.json(resError('Target agent not found'), 404);
  }
  if (targetAgent.rig_id !== params.rigId) {
    return c.json(resError('Target agent does not belong to this rig'), 403);
  }

  // Hook the new agent first — if this fails, the old assignment is untouched
  await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.hookBead(parsed.data.agent_id, params.beadId),
    'TownDO.hookBead(mayorBeadReassign)'
  );

  // Only unhook the old agent if it is still hooked to this specific bead
  const prevAssigneeId = bead.assignee_agent_bead_id;
  if (prevAssigneeId && prevAssigneeId !== parsed.data.agent_id) {
    const oldAgent = await withDORetry(
      () => getTownDOStub(c.env, params.townId),
      stub => stub.getAgentAsync(prevAssigneeId),
      'TownDO.getAgentAsync(mayorBeadReassign-oldAgent)'
    );
    if (oldAgent && oldAgent.current_hook_bead_id === params.beadId) {
      await withDORetry(
        () => getTownDOStub(c.env, params.townId),
        stub => stub.unhookBead(prevAssigneeId),
        'TownDO.unhookBead(mayorBeadReassign)'
      );
    }
  }

  // Return the updated bead so clients can read the new assignee
  const updated = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.getBeadAsync(params.beadId),
    'TownDO.getBeadAsync(mayorBeadReassign-updated)'
  );
  return c.json(resSuccess(updated));
}

/**
 * POST /api/mayor/:townId/tools/rigs/:rigId/agents/:agentId/reset
 * Force-reset an agent to idle, unhooking from any current bead.
 */
export async function handleMayorAgentReset(
  c: Context<GastownEnv>,
  params: { townId: string; rigId: string; agentId: string }
) {
  const rigOwned = await verifyRigBelongsToTown(c, params.townId, params.rigId);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleMayorAgentReset: townId=${params.townId} rigId=${params.rigId} agentId=${params.agentId}`
  );

  // Verify the agent belongs to this rig
  const agent = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.getAgentAsync(params.agentId),
    'TownDO.getAgentAsync(mayorAgentReset)'
  );
  if (!agent) {
    return c.json(resError('Agent not found'), 404);
  }
  if (agent.rig_id !== params.rigId) {
    return c.json(resError('Agent does not belong to this rig'), 403);
  }

  await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.resetAgent(params.agentId),
    'TownDO.resetAgent(mayorAgentReset)'
  );

  return c.json(resSuccess({ reset: true }));
}

/**
 * POST /api/mayor/:townId/tools/convoys/:convoyId/close
 * Force-close a convoy and all its tracked open beads.
 */
export async function handleMayorConvoyClose(
  c: Context<GastownEnv>,
  params: { townId: string; convoyId: string }
) {
  console.log(
    `${HANDLER_LOG} handleMayorConvoyClose: townId=${params.townId} convoyId=${params.convoyId}`
  );

  const convoy = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.closeConvoy(params.convoyId),
    'TownDO.closeConvoy(mayorConvoyClose)'
  );

  if (!convoy) return c.json(resError('Convoy not found'), 404);
  return c.json(resSuccess(convoy));
}

/**
 * PATCH /api/mayor/:townId/tools/convoys/:convoyId
 * Edit convoy metadata (merge_mode or feature_branch).
 */
export async function handleMayorConvoyUpdate(
  c: Context<GastownEnv>,
  params: { townId: string; convoyId: string }
) {
  const parsed = ConvoyUpdateBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleMayorConvoyUpdate: townId=${params.townId} convoyId=${params.convoyId}`
  );

  const convoy = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.updateConvoy(params.convoyId, parsed.data),
    'TownDO.updateConvoy(mayorConvoyUpdate)'
  );

  if (!convoy) return c.json(resError('Convoy not found'), 404);
  return c.json(resSuccess(convoy));
}

/**
 * DELETE /api/mayor/:townId/tools/rigs/:rigId/beads/:beadId
 * Delete a bead that belongs to the specified rig.
 */
export async function handleMayorBeadDelete(
  c: Context<GastownEnv>,
  params: { townId: string; rigId: string; beadId: string }
) {
  const rigOwned = await verifyRigBelongsToTown(c, params.townId, params.rigId);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleMayorBeadDelete: townId=${params.townId} rigId=${params.rigId} beadId=${params.beadId}`
  );

  // Verify the bead belongs to this rig
  const bead = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.getBeadAsync(params.beadId),
    'TownDO.getBeadAsync(mayorBeadDelete)'
  );
  if (!bead) {
    return c.json(resError('Bead not found'), 404);
  }
  if (bead.rig_id !== params.rigId) {
    return c.json(resError('Bead does not belong to this rig'), 403);
  }

  await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.deleteBead(params.beadId),
    'TownDO.deleteBead(mayorBeadDelete)'
  );

  return c.json(resSuccess({ deleted: true }));
}

/**
 * POST /api/mayor/:townId/tools/escalations/:escalationId/acknowledge
 * Acknowledge an escalation, marking it as reviewed.
 */
export async function handleMayorEscalationAcknowledge(
  c: Context<GastownEnv>,
  params: { townId: string; escalationId: string }
) {
  console.log(
    `${HANDLER_LOG} handleMayorEscalationAcknowledge: townId=${params.townId} escalationId=${params.escalationId}`
  );

  const escalation = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.acknowledgeEscalation(params.escalationId),
    'TownDO.acknowledgeEscalation(mayorEscalationAck)'
  );

  if (!escalation) return c.json(resError('Escalation not found'), 404);
  return c.json(resSuccess(escalation));
}

/**
 * POST /api/mayor/:townId/tools/convoys/:convoyId/start
 * Transition a staged convoy to active: hook agents and begin dispatch.
 */
export async function handleMayorConvoyStart(
  c: Context<GastownEnv>,
  params: { townId: string; convoyId: string }
) {
  console.log(
    `${HANDLER_LOG} handleMayorConvoyStart: townId=${params.townId} convoyId=${params.convoyId}`
  );

  let result: { convoy: { id: string }; beads: unknown[] };
  try {
    result = await withDORetry(
      () => getTownDOStub(c.env, params.townId),
      stub => stub.startConvoy(params.convoyId),
      'TownDO.startConvoy(mayorConvoyStart)'
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found') || message.includes('not staged')) {
      return c.json(resError('Convoy not found or not staged'), 404);
    }
    throw err;
  }

  console.log(
    `${HANDLER_LOG} handleMayorConvoyStart: completed, convoy=${result.convoy.id} beads=${result.beads.length}`
  );

  return c.json(resSuccess(result));
}

const MayorUiActionBody = z.object({
  action: UiActionSchema,
});

/**
 * POST /api/mayor/:townId/tools/ui-action
 * Mayor tool: broadcast a UI action to all connected dashboard WebSocket clients.
 * Allows the mayor to trigger navigation/drawer actions in the user's dashboard.
 */
export async function handleMayorUiAction(c: Context<GastownEnv>, params: { townId: string }) {
  const body = await parseJsonBody(c);
  const parsed = MayorUiActionBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleMayorUiAction: townId=${params.townId} type=${parsed.data.action.type}`
  );

  const action = normalizeUiAction(parsed.data.action, params.townId);

  // Validate that the referenced rig belongs to this town
  const rigId = uiActionRigId(action);
  if (rigId) {
    const rig = await withDORetry(
      () => getTownDOStub(c.env, params.townId),
      stub => stub.getRigAsync(rigId),
      'TownDO.getRigAsync(mayorUiAction)'
    );
    if (!rig) {
      return c.json({ success: false, error: `Rig ${rigId} does not belong to this town` }, 400);
    }
  }

  await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.broadcastUiAction(action),
    'TownDO.broadcastUiAction(mayorUiAction)'
  );
  return c.json(resSuccess({ broadcast: true }), 200);
}
