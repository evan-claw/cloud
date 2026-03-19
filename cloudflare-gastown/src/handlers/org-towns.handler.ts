import type { Context } from 'hono';
import { z } from 'zod';
import { getGastownOrgStub } from '../dos/GastownOrg.do';
import { getTownDOStub } from '../dos/Town.do';
import { withDORetry } from '@kilocode/worker-utils';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { GastownEnv } from '../gastown.worker';

const ORG_TOWNS_LOG = '[org-towns.handler]';

const CreateOrgTownBody = z.object({
  name: z.string().min(1).max(64),
});

const CreateOrgRigBody = z.object({
  town_id: z.string().min(1),
  name: z.string().min(1).max(64),
  git_url: z.string().url(),
  default_branch: z.string().min(1).default('main'),
  platform_integration_id: z.string().min(1).optional(),
});

export async function handleCreateOrgTown(c: Context<GastownEnv>, params: { orgId: string }) {
  const parsed = CreateOrgTownBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  const town = await withDORetry(
    () => getGastownOrgStub(c.env, params.orgId),
    stub =>
      stub.createTown({
        name: parsed.data.name,
        owner_org_id: params.orgId,
        created_by_user_id: userId,
      }),
    'GastawnOrgDO.createTown'
  );

  // Initialize the TownDO config with org ownership metadata
  await withDORetry(
    () => getTownDOStub(c.env, town.id),
    stub => stub.setTownId(town.id),
    'TownDO.setTownId(createOrgTown)'
  );
  await withDORetry(
    () => getTownDOStub(c.env, town.id),
    stub =>
      stub.updateTownConfig({
        owner_type: 'org',
        owner_id: params.orgId,
        owner_user_id: userId,
        organization_id: params.orgId,
        created_by_user_id: userId,
      }),
    'TownDO.updateTownConfig(createOrgTown)'
  );

  return c.json(resSuccess(town), 201);
}

export async function handleListOrgTowns(c: Context<GastownEnv>, params: { orgId: string }) {
  const towns = await withDORetry(
    () => getGastownOrgStub(c.env, params.orgId),
    stub => stub.listTowns(),
    'GastawnOrgDO.listTowns'
  );
  return c.json(resSuccess(towns));
}

export async function handleGetOrgTown(
  c: Context<GastownEnv>,
  params: { orgId: string; townId: string }
) {
  const town = await withDORetry(
    () => getGastownOrgStub(c.env, params.orgId),
    stub => stub.getTownAsync(params.townId),
    'GastawnOrgDO.getTownAsync'
  );
  if (!town) return c.json(resError('Town not found'), 404);
  return c.json(resSuccess(town));
}

export async function handleCreateOrgRig(c: Context<GastownEnv>, params: { orgId: string }) {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  const parsed = CreateOrgRigBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    console.error(`${ORG_TOWNS_LOG} handleCreateOrgRig: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${ORG_TOWNS_LOG} handleCreateOrgRig: orgId=${params.orgId} town_id=${parsed.data.town_id} name=${parsed.data.name} git_url=${parsed.data.git_url}`
  );

  // Verify the town belongs to this org before creating the rig
  const town = await withDORetry(
    () => getGastownOrgStub(c.env, params.orgId),
    stub => stub.getTownAsync(parsed.data.town_id),
    'GastawnOrgDO.getTownAsync(createOrgRig)'
  );
  if (!town) return c.json(resError('Town not found in this org'), 404);

  const rig = await withDORetry(
    () => getGastownOrgStub(c.env, params.orgId),
    stub => stub.createRig(parsed.data),
    'GastawnOrgDO.createRig'
  );
  console.log(
    `${ORG_TOWNS_LOG} handleCreateOrgRig: rig created id=${rig.id}, now configuring Town DO`
  );

  // Configure the Town DO with rig metadata and register the rig.
  // If this fails, roll back the rig creation to avoid an orphaned record.
  try {
    await withDORetry(
      () => getTownDOStub(c.env, parsed.data.town_id),
      stub => stub.setTownId(parsed.data.town_id),
      'TownDO.setTownId(createOrgRig)'
    );
    await withDORetry(
      () => getTownDOStub(c.env, parsed.data.town_id),
      stub =>
        stub.configureRig({
          rigId: rig.id,
          townId: parsed.data.town_id,
          gitUrl: parsed.data.git_url,
          defaultBranch: parsed.data.default_branch,
          userId,
          // Never trust caller-supplied kilocode tokens for org rigs — the
          // town's existing token (minted by the owner) is used instead.
          kilocodeToken: undefined,
          platformIntegrationId: parsed.data.platform_integration_id,
        }),
      'TownDO.configureRig(createOrgRig)'
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
      'TownDO.addRig(createOrgRig)'
    );
    console.log(`${ORG_TOWNS_LOG} handleCreateOrgRig: Town DO configured and rig registered`);
  } catch (err) {
    console.error(
      `${ORG_TOWNS_LOG} handleCreateOrgRig: Town DO configure FAILED for rig ${rig.id}, rolling back:`,
      err
    );
    try {
      await withDORetry(
        () => getGastownOrgStub(c.env, params.orgId),
        stub => stub.deleteRig(rig.id),
        'GastawnOrgDO.deleteRig(rollback)'
      );
    } catch {
      /* best effort rollback */
    }
    return c.json(resError('Failed to configure rig'), 500);
  }

  return c.json(resSuccess(rig), 201);
}

export async function handleListOrgRigs(
  c: Context<GastownEnv>,
  params: { orgId: string; townId: string }
) {
  const rigs = await withDORetry(
    () => getGastownOrgStub(c.env, params.orgId),
    stub => stub.listRigs(params.townId),
    'GastawnOrgDO.listRigs'
  );
  return c.json(resSuccess(rigs));
}

export async function handleGetOrgRig(
  c: Context<GastownEnv>,
  params: { orgId: string; rigId: string }
) {
  const rig = await withDORetry(
    () => getGastownOrgStub(c.env, params.orgId),
    stub => stub.getRigAsync(params.rigId),
    'GastawnOrgDO.getRigAsync'
  );
  if (!rig) return c.json(resError('Rig not found'), 404);
  return c.json(resSuccess(rig));
}

export async function handleDeleteOrgTown(
  c: Context<GastownEnv>,
  params: { orgId: string; townId: string }
) {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  // Verify owner role via JWT claims (works in dev mode where orgAuthMiddleware is skipped)
  const memberships = c.get('kiloOrgMemberships') ?? [];
  const membership = memberships.find(m => m.orgId === params.orgId);
  if (!membership || membership.role !== 'owner') {
    return c.json(resError('Only org owners can delete towns'), 403);
  }

  // Verify the town belongs to this org BEFORE destroying anything
  const town = await withDORetry(
    () => getGastownOrgStub(c.env, params.orgId),
    stub => stub.getTownAsync(params.townId),
    'GastawnOrgDO.getTownAsync(deleteOrgTown)'
  );
  if (!town) return c.json(resError('Town not found'), 404);

  // Destroy the Town DO (handles all rigs, agents, and mayor cleanup)
  try {
    await withDORetry(
      () => getTownDOStub(c.env, params.townId),
      stub => stub.destroy(),
      'TownDO.destroy(deleteOrgTown)'
    );
    console.log(
      `${ORG_TOWNS_LOG} handleDeleteOrgTown: Town DO destroyed for town ${params.townId}`
    );
  } catch (err) {
    console.error(`${ORG_TOWNS_LOG} handleDeleteOrgTown: failed to destroy Town DO:`, err);
  }

  const deleted = await withDORetry(
    () => getGastownOrgStub(c.env, params.orgId),
    stub => stub.deleteTown(params.townId),
    'GastawnOrgDO.deleteTown'
  );
  if (!deleted) return c.json(resError('Town not found'), 404);
  return c.json(resSuccess({ deleted: true }));
}

export async function handleDeleteOrgRig(
  c: Context<GastownEnv>,
  params: { orgId: string; rigId: string }
) {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  // Verify owner role via JWT claims (works in dev mode where orgAuthMiddleware is skipped)
  const memberships = c.get('kiloOrgMemberships') ?? [];
  const membership = memberships.find(m => m.orgId === params.orgId);
  if (!membership || membership.role !== 'owner') {
    return c.json(resError('Only org owners can delete rigs'), 403);
  }

  const rig = await withDORetry(
    () => getGastownOrgStub(c.env, params.orgId),
    stub => stub.getRigAsync(params.rigId),
    'GastawnOrgDO.getRigAsync(deleteOrgRig)'
  );
  if (!rig) return c.json(resError('Rig not found'), 404);

  const deleted = await withDORetry(
    () => getGastownOrgStub(c.env, params.orgId),
    stub => stub.deleteRig(params.rigId),
    'GastawnOrgDO.deleteRig'
  );
  if (!deleted) return c.json(resError('Rig not found'), 404);

  // Remove the rig from the Town DO
  try {
    await withDORetry(
      () => getTownDOStub(c.env, rig.town_id),
      stub => stub.removeRig(params.rigId),
      'TownDO.removeRig(deleteOrgRig)'
    );
  } catch (err) {
    console.error(`${ORG_TOWNS_LOG} handleDeleteOrgRig: failed to remove rig from Town DO:`, err);
  }

  return c.json(resSuccess({ deleted: true }));
}
