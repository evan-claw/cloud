import type { Context } from 'hono';
import { z } from 'zod';
import { getGastownUserStub } from '../dos/GastownUser.do';
import { getTownDOStub } from '../dos/Town.do';
import { withDORetry } from '@kilocode/worker-utils';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { GastownEnv } from '../gastown.worker';

const TOWNS_LOG = '[towns.handler]';

const CreateTownBody = z.object({
  name: z.string().min(1).max(64),
});

const CreateRigBody = z.object({
  town_id: z.string().min(1),
  name: z.string().min(1).max(64),
  git_url: z.string().url(),
  default_branch: z.string().min(1).default('main'),
  kilocode_token: z.string().min(1).optional(),
  platform_integration_id: z.string().min(1).optional(),
});

/**
 * Town DO instances are keyed by owner_user_id (the :userId path param)
 * so all of a user's towns live in a single DO instance.
 */

export async function handleCreateTown(c: Context<GastownEnv>, params: { userId: string }) {
  const parsed = CreateTownBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const town = await withDORetry(
    () => getGastownUserStub(c.env, params.userId),
    stub => stub.createTown({ name: parsed.data.name, owner_user_id: params.userId }),
    'GastownUserDO.createTown'
  );
  return c.json(resSuccess(town), 201);
}

export async function handleListTowns(c: Context<GastownEnv>, params: { userId: string }) {
  const towns = await withDORetry(
    () => getGastownUserStub(c.env, params.userId),
    stub => stub.listTowns(),
    'GastownUserDO.listTowns'
  );
  return c.json(resSuccess(towns));
}

export async function handleGetTown(
  c: Context<GastownEnv>,
  params: { userId: string; townId: string }
) {
  const town = await withDORetry(
    () => getGastownUserStub(c.env, params.userId),
    stub => stub.getTownAsync(params.townId),
    'GastownUserDO.getTownAsync'
  );
  if (!town) return c.json(resError('Town not found'), 404);
  return c.json(resSuccess(town));
}

export async function handleCreateRig(c: Context<GastownEnv>, params: { userId: string }) {
  const parsed = CreateRigBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    console.error(`${TOWNS_LOG} handleCreateRig: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${TOWNS_LOG} handleCreateRig: userId=${params.userId} town_id=${parsed.data.town_id} name=${parsed.data.name} git_url=${parsed.data.git_url} hasKilocodeToken=${!!parsed.data.kilocode_token}`
  );

  const rig = await withDORetry(
    () => getGastownUserStub(c.env, params.userId),
    stub => stub.createRig(parsed.data),
    'GastownUserDO.createRig'
  );
  console.log(`${TOWNS_LOG} handleCreateRig: rig created id=${rig.id}, now configuring Rig DO`);

  // Configure the Town DO with rig metadata and register the rig.
  // If this fails, roll back the rig creation to avoid an orphaned record.
  try {
    await withDORetry(
      () => getTownDOStub(c.env, parsed.data.town_id),
      stub =>
        stub.configureRig({
          rigId: rig.id,
          townId: parsed.data.town_id,
          gitUrl: parsed.data.git_url,
          defaultBranch: parsed.data.default_branch,
          userId: params.userId,
          kilocodeToken: parsed.data.kilocode_token,
          platformIntegrationId: parsed.data.platform_integration_id,
        }),
      'TownDO.configureRig'
    );
    await withDORetry(
      () => getTownDOStub(c.env, parsed.data.town_id),
      stub =>
        stub.addRig({
          rigId: rig.id,
          name: parsed.data.name,
          gitUrl: parsed.data.git_url,
          defaultBranch: parsed.data.default_branch,
        }),
      'TownDO.addRig'
    );
    console.log(`${TOWNS_LOG} handleCreateRig: Town DO configured and rig registered`);
  } catch (err) {
    console.error(
      `${TOWNS_LOG} handleCreateRig: Town DO configure FAILED for rig ${rig.id}, rolling back:`,
      err
    );
    await withDORetry(
      () => getGastownUserStub(c.env, params.userId),
      stub => stub.deleteRig(rig.id),
      'GastownUserDO.deleteRig(rollback)'
    );
    return c.json(resError('Failed to configure rig'), 500);
  }

  return c.json(resSuccess(rig), 201);
}

export async function handleGetRig(
  c: Context<GastownEnv>,
  params: { userId: string; rigId: string }
) {
  const rig = await withDORetry(
    () => getGastownUserStub(c.env, params.userId),
    stub => stub.getRigAsync(params.rigId),
    'GastownUserDO.getRigAsync'
  );
  if (!rig) return c.json(resError('Rig not found'), 404);
  return c.json(resSuccess(rig));
}

export async function handleListRigs(
  c: Context<GastownEnv>,
  params: { userId: string; townId: string }
) {
  const rigs = await withDORetry(
    () => getGastownUserStub(c.env, params.userId),
    stub => stub.listRigs(params.townId),
    'GastownUserDO.listRigs'
  );
  return c.json(resSuccess(rigs));
}

export async function handleDeleteTown(
  c: Context<GastownEnv>,
  params: { userId: string; townId: string }
) {
  // Destroy the Town DO (handles all rigs, agents, and mayor cleanup)
  try {
    await withDORetry(
      () => getTownDOStub(c.env, params.townId),
      stub => stub.destroy(),
      'TownDO.destroy'
    );
    console.log(`${TOWNS_LOG} handleDeleteTown: Town DO destroyed for town ${params.townId}`);
  } catch (err) {
    console.error(`${TOWNS_LOG} handleDeleteTown: failed to destroy Town DO:`, err);
  }

  const deleted = await withDORetry(
    () => getGastownUserStub(c.env, params.userId),
    stub => stub.deleteTown(params.townId),
    'GastownUserDO.deleteTown'
  );
  if (!deleted) return c.json(resError('Town not found'), 404);
  return c.json(resSuccess({ deleted: true }));
}

export async function handleDeleteRig(
  c: Context<GastownEnv>,
  params: { userId: string; rigId: string }
) {
  const rig = await withDORetry(
    () => getGastownUserStub(c.env, params.userId),
    stub => stub.getRigAsync(params.rigId),
    'GastownUserDO.getRigAsync(deleteRig)'
  );
  if (!rig) return c.json(resError('Rig not found'), 404);

  const deleted = await withDORetry(
    () => getGastownUserStub(c.env, params.userId),
    stub => stub.deleteRig(params.rigId),
    'GastownUserDO.deleteRig'
  );
  if (!deleted) return c.json(resError('Rig not found'), 404);

  // Remove the rig from the Town DO
  try {
    await withDORetry(
      () => getTownDOStub(c.env, rig.town_id),
      stub => stub.removeRig(params.rigId),
      'TownDO.removeRig'
    );
  } catch (err) {
    console.error(`${TOWNS_LOG} handleDeleteRig: failed to remove rig from Town DO:`, err);
  }

  return c.json(resSuccess({ deleted: true }));
}
