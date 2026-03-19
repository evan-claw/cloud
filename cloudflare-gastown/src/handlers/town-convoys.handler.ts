import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { withDORetry } from '@kilocode/worker-utils';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { GastownEnv } from '../gastown.worker';

const CreateConvoyBody = z.object({
  title: z.string().min(1),
  beads: z
    .array(
      z.object({
        bead_id: z.string().min(1),
        rig_id: z.string().min(1),
      })
    )
    .min(1),
  created_by: z.string().min(1).optional(),
});

export async function handleCreateConvoy(c: Context<GastownEnv>, params: { townId: string }) {
  const body = await parseJsonBody(c);
  const parsed = CreateConvoyBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const convoy = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub => stub.createConvoy(parsed.data),
    'TownDO.createConvoy'
  );
  return c.json(resSuccess(convoy), 201);
}

const OnBeadClosedBody = z.object({
  convoy_id: z.string().min(1),
  bead_id: z.string().min(1),
});

export async function handleOnBeadClosed(c: Context<GastownEnv>, params: { townId: string }) {
  const body = await parseJsonBody(c);
  const parsed = OnBeadClosedBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const convoy = await withDORetry(
    () => getTownDOStub(c.env, params.townId),
    stub =>
      stub.onBeadClosed({
        convoyId: parsed.data.convoy_id,
        beadId: parsed.data.bead_id,
      }),
    'TownDO.onBeadClosed'
  );

  if (!convoy) return c.json(resError('Convoy not found'), 404);
  return c.json(resSuccess(convoy));
}
