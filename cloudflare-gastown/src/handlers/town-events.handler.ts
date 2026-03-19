import type { Context } from 'hono';
import { getTownDOStub } from '../dos/Town.do';
import { withDORetry } from '@kilocode/worker-utils';
import { resSuccess } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

/**
 * List bead events for a town. Since all data lives in the Town DO now,
 * this is a single call rather than a fan-out across Rig DOs.
 * GET /api/users/:userId/towns/:townId/events?since=<iso>&limit=<n>
 */
export async function handleListTownEvents(
  c: Context<GastownEnv>,
  params: { userId: string; townId: string }
) {
  const since = c.req.query('since') ?? undefined;
  const limitStr = c.req.query('limit');
  const parsedLimit = limitStr !== undefined ? Number(limitStr) : undefined;
  const limit =
    parsedLimit !== undefined && Number.isInteger(parsedLimit) && parsedLimit >= 0
      ? parsedLimit
      : 100;

  const events = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.listBeadEvents({ since, limit }),
    'TownDO.listBeadEvents(townEvents)'
  );

  return c.json(resSuccess(events));
}
