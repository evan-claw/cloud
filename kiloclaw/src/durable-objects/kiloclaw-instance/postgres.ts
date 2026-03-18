import type { KiloClawEnv } from '../../types';
import type { EncryptedEnvelope } from '../../schemas/instance-config';
import { getWorkerDb, getActiveInstance, markInstanceDestroyed } from '../../db';
import { appNameFromUserId } from '../../fly/apps';
import type { InstanceMutableState } from './types';
import { storageUpdate } from './state';
import { doError, doWarn, toLoggable } from './log';

/**
 * Restore DO state from Postgres backup if SQLite was wiped.
 */
export async function restoreFromPostgres(
  env: KiloClawEnv,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  userId: string
): Promise<void> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    doWarn(state, 'HYPERDRIVE not configured, cannot restore from Postgres');
    return;
  }

  try {
    const db = getWorkerDb(connectionString);
    const instance = await getActiveInstance(db, userId);

    if (!instance) {
      doWarn(state, 'No active instance found in Postgres', { userId });
      return;
    }

    console.log('[DO] Restoring state from Postgres backup for', userId);

    const envVars: Record<string, string> | null = null;
    const encryptedSecrets: Record<string, EncryptedEnvelope> | null = null;
    const channels = null;

    // Recover flyAppName from the App DO or derive deterministically.
    const appStub = env.KILOCLAW_APP.get(env.KILOCLAW_APP.idFromName(userId));
    const prefix = env.WORKER_ENV === 'development' ? 'dev' : undefined;
    const recoveredAppName =
      (await appStub.getAppName()) ?? (await appNameFromUserId(userId, prefix));

    await ctx.storage.put(
      storageUpdate({
        userId,
        sandboxId: instance.sandboxId,
        status: 'provisioned',
        envVars,
        encryptedSecrets,
        channels,
        provisionedAt: Date.now(),
        lastStartedAt: null,
        lastStoppedAt: null,
        flyAppName: recoveredAppName,
        flyMachineId: null,
        flyVolumeId: null,
        flyRegion: null,
        machineSize: null,
        healthCheckFailCount: 0,
        pendingDestroyMachineId: null,
        pendingDestroyVolumeId: null,
        pendingPostgresMarkOnFinalize: false,
        lastMetadataRecoveryAt: null,
        openclawVersion: null,
        imageVariant: null,
        trackedImageTag: null,
        instanceFeatures: [],
      })
    );

    state.userId = userId;
    state.sandboxId = instance.sandboxId;
    state.status = 'provisioned';
    state.envVars = envVars;
    state.encryptedSecrets = encryptedSecrets;
    state.channels = channels;
    state.provisionedAt = Date.now();
    state.lastStartedAt = null;
    state.lastStoppedAt = null;
    state.flyAppName = recoveredAppName;
    state.flyMachineId = null;
    state.flyVolumeId = null;
    state.flyRegion = null;
    state.machineSize = null;
    state.healthCheckFailCount = 0;
    state.pendingDestroyMachineId = null;
    state.pendingDestroyVolumeId = null;
    state.pendingPostgresMarkOnFinalize = false;
    state.lastMetadataRecoveryAt = null;
    state.openclawVersion = null;
    state.imageVariant = null;
    state.trackedImageTag = null;
    state.trackedImageDigest = null;
    state.instanceFeatures = [];
    state.loaded = true;

    console.log('[DO] Restored from Postgres: sandboxId =', instance.sandboxId);

    // Machine/volume recovery is intentionally NOT done here.
    // The caller (_startInner) already calls attemptMetadataRecovery after restore.
    // Calling it here too would set the recovery cooldown, causing the caller's
    // attempt to short-circuit and incorrectly abort machine creation.
  } catch (err) {
    doError(state, 'Postgres restore failed', { error: toLoggable(err) });
  }
}

/**
 * Mark the Postgres registry row as destroyed.
 */
export async function markDestroyedInPostgresHelper(
  env: KiloClawEnv,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  userId: string,
  sandboxId: string
): Promise<boolean> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    doWarn(state, 'HYPERDRIVE not configured, skipping Postgres mark-destroyed');
    return true;
  }

  try {
    const db = getWorkerDb(connectionString);
    await markInstanceDestroyed(db, userId, sandboxId);
    state.pendingPostgresMarkOnFinalize = false;
    await ctx.storage.put(storageUpdate({ pendingPostgresMarkOnFinalize: false }));
    return true;
  } catch (err) {
    doError(state, 'Failed to mark instance destroyed in Postgres', {
      error: toLoggable(err),
    });
    return false;
  }
}
