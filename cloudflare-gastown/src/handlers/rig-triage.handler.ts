/**
 * Triage resolve handler — called by the short-lived triage agent to
 * resolve a triage_request bead with a chosen action.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import type { GastownEnv } from '../gastown.worker';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getEnforcedAgentId } from '../middleware/auth.middleware';

const TriageResolveBody = z.object({
  action: z.enum(['RESTART', 'ESCALATE', 'DISCARD']),
  notes: z.string().optional(),
});

/**
 * POST /api/towns/:townId/rigs/:rigId/triage/:triageBeadId/resolve
 * Resolve a triage_request bead. Called by the triage agent via gt_triage_resolve.
 */
export async function handleTriageResolve(
  c: Context<GastownEnv>,
  params: { townId: string; rigId: string; triageBeadId: string }
) {
  const body = await parseJsonBody(c);
  const parsed = TriageResolveBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const callerAgentId = getEnforcedAgentId(c);
  if (!callerAgentId) {
    return c.json({ success: false, error: 'Agent ID not found in token' }, 401);
  }

  const town = getTownDOStub(c.env, params.townId);
  const result = await town.resolveTriageRequest(
    params.triageBeadId,
    parsed.data.action,
    callerAgentId,
    parsed.data.notes
  );
  return c.json(resSuccess(result), 200);
}
