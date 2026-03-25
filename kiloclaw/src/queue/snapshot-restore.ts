/**
 * Queue consumer for snapshot restore orchestration.
 *
 * Processes one restore job at a time (max_batch_size: 1). Each job:
 * 1. Checks idempotency (volume already swapped → ack and skip)
 * 2. Marks restore as started (UI transitions from "Queued" to "Restoring...")
 * 3. Stops the machine if running
 * 4. Creates a new volume from the snapshot via Fly API
 * 5. Swaps the volume reference in DO state
 * 6. Starts the machine with the restored volume
 *
 * The old volume is NOT deleted — it's retained for admin revert via Volume Reassociation.
 *
 * Idempotency: If the message is delivered more than once (at-least-once guarantee),
 * the worker checks if flyVolumeId still matches previousVolumeId. If not, the
 * restore already completed — ack and skip.
 */

import type { KiloClawEnv } from '../types';
import type { SnapshotRestoreMessage } from '../schemas/snapshot-restore';
import { SnapshotRestoreMessageSchema } from '../schemas/snapshot-restore';
import * as fly from '../fly/client';

export async function handleSnapshotRestoreQueue(
  batch: MessageBatch<SnapshotRestoreMessage>,
  env: KiloClawEnv
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = SnapshotRestoreMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error('[queue] Invalid snapshot restore message, acking to discard:', parsed.error);
      message.ack();
      continue;
    }

    const { userId, snapshotId, previousVolumeId, region } = parsed.data;
    const stub = env.KILOCLAW_INSTANCE.get(env.KILOCLAW_INSTANCE.idFromName(userId));

    try {
      // Step 0: Idempotency check — has the volume already been swapped?
      const status = await stub.getStatus();
      if (status.flyVolumeId !== previousVolumeId) {
        console.log(
          `[queue] Restore already completed for user=${userId} (volume already swapped from ${previousVolumeId} to ${status.flyVolumeId}), acking`
        );
        message.ack();
        continue;
      }

      console.log(`[queue] Restore started for user=${userId} snapshot=${snapshotId}`);

      // Step 1: Stop the machine if running
      try {
        await stub.stop();
      } catch (err) {
        // stop() no-ops for non-running statuses, but may throw for unprovisioned
        console.warn('[queue] Stop during restore (non-fatal):', err);
      }

      // Step 2: Destroy the machine to release the old volume's attachment.
      // Fly only clears attached_machine_id when the machine is destroyed.
      // start() will create a fresh machine with the new volume mount.
      await stub.destroyMachineForRestore();

      // Step 3: Create new volume from snapshot via Fly API
      const flyAppName = status.flyAppName ?? env.FLY_APP_NAME;
      if (!flyAppName || !env.FLY_API_TOKEN) {
        throw new Error('Missing Fly app name or API token');
      }

      const flyConfig = { apiToken: env.FLY_API_TOKEN, appName: flyAppName };
      const existingVolume = await fly.getVolume(flyConfig, previousVolumeId);
      const volumeName = existingVolume.name;

      // Guard against volume leak on retry: if a prior attempt created a volume but
      // completeSnapshotRestore() failed, there's an orphaned volume in the app.
      // Check for a recently created volume with the same name in the same region
      // that isn't the previous volume — if found, reuse it instead of creating another.
      let newVolume: Awaited<ReturnType<typeof fly.createVolume>>;
      const allVolumes = await fly.listVolumes(flyConfig);
      const candidateFromPriorAttempt = allVolumes.find(
        v =>
          v.id !== previousVolumeId &&
          v.name === volumeName &&
          v.region === region &&
          v.state !== 'destroyed' &&
          v.state !== 'destroying' &&
          !v.attached_machine_id
      );

      if (candidateFromPriorAttempt) {
        console.log(`[queue] Reusing volume from prior attempt: ${candidateFromPriorAttempt.id}`);
        newVolume = candidateFromPriorAttempt;
      } else {
        newVolume = await fly.createVolume(flyConfig, {
          name: volumeName,
          region,
          snapshot_id: snapshotId,
          size_gb: existingVolume.size_gb,
          snapshot_retention: 5,
        });
        console.log(
          `[queue] New volume created: id=${newVolume.id} region=${newVolume.region} from snapshot=${snapshotId}`
        );
      }

      // Step 4: Swap volume in DO state (also persists previousVolumeId for revert path)
      await stub.completeSnapshotRestore(newVolume.id, newVolume.region);

      // Step 5: Start the machine with the restored volume (creates a fresh machine)
      try {
        await stub.start(userId);
        console.log(`[queue] Machine started after restore for user=${userId}`);
      } catch (startErr) {
        // Restore succeeded even if start fails — the volume is swapped.
        // Instance is in 'stopped' state; admin can start manually.
        console.error('[queue] Failed to start machine after restore (non-fatal):', startErr);
      }

      message.ack();
      console.log(
        `[queue] Snapshot restore completed: user=${userId} snapshot=${snapshotId} oldVolume=${previousVolumeId} newVolume=${newVolume.id}`
      );
    } catch (err) {
      console.error(
        `[queue] Snapshot restore failed for user=${userId} snapshot=${snapshotId}:`,
        err
      );

      // If this is the last retry, reset status so the instance isn't stuck.
      // CF Queues: message.attempts starts at 1 and increments. max_retries=2 means
      // up to 3 total attempts (1 initial + 2 retries).
      if (message.attempts >= 3) {
        console.error(
          `[queue] All retries exhausted for user=${userId}, resetting to stopped. Message will go to DLQ.`
        );
        try {
          await stub.failSnapshotRestore();
        } catch (failErr) {
          console.error('[queue] Failed to reset restore status:', failErr);
        }
      }

      message.retry();
    }
  }
}
