import type { Context } from 'hono';
import { getTownDOStub } from '../dos/Town.do';
import { withDORetry } from '@kilocode/worker-utils';
import { resSuccess, resError } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

export async function handleListEscalations(c: Context<GastownEnv>, params: { townId: string }) {
  const acknowledged = c.req.query('acknowledged');
  const filter = acknowledged !== undefined ? { acknowledged: acknowledged === 'true' } : undefined;

  const escalations = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.listEscalations(filter),
    'TownDO.listEscalations'
  );
  return c.json(resSuccess(escalations));
}

export async function handleAcknowledgeEscalation(
  c: Context<GastownEnv>,
  params: { townId: string; escalationId: string }
) {
  const escalation = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.acknowledgeEscalation(params.escalationId),
    'TownDO.acknowledgeEscalation'
  );
  if (!escalation) return c.json(resError('Escalation not found'), 404);
  return c.json(resSuccess(escalation));
}
