import type { Context } from 'hono';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

export async function handleListBeadEvents(c: Context<GastownEnv>, params: { rigId: string }) {
  const since = c.req.query('since') ?? undefined;
  const beadId = c.req.query('bead_id') ?? undefined;
  const limitStr = c.req.query('limit');
  const parsedLimit = limitStr !== undefined ? Number(limitStr) : undefined;
  const limit =
    parsedLimit !== undefined && Number.isInteger(parsedLimit) && parsedLimit >= 0
      ? parsedLimit
      : undefined;

  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const events = await town.listBeadEvents({ beadId, since, limit });
  return c.json(resSuccess(events));
}
