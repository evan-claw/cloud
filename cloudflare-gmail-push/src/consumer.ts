import type { AppEnv, GmailPushQueueMessage } from './types';

/**
 * Best-effort: extract historyId from Pub/Sub payload and report to DO.
 * Failures are logged but never cause message retry.
 */
async function reportHistoryId(
  userId: string,
  pubSubBody: string,
  env: AppEnv,
  internalSecret: string
): Promise<void> {
  try {
    const parsed = JSON.parse(pubSubBody);
    const data = parsed?.message?.data;
    if (typeof data !== 'string') return;

    const decoded = JSON.parse(atob(data));
    const historyId = decoded?.historyId;
    if (typeof historyId !== 'string' && typeof historyId !== 'number') return;

    await env.KILOCLAW.fetch(
      new Request('https://kiloclaw/api/platform/gmail-history-id', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': internalSecret,
        },
        body: JSON.stringify({ userId, historyId: String(historyId) }),
      })
    );
  } catch (err) {
    console.warn(`[gmail-push] Failed to report historyId for user ${userId}:`, err);
  }
}

export async function handleQueue(
  batch: MessageBatch<GmailPushQueueMessage>,
  env: AppEnv
): Promise<void> {
  await Promise.allSettled(batch.messages.map(message => processMessage(message, env)));
}

async function processMessage(message: Message<GmailPushQueueMessage>, env: AppEnv): Promise<void> {
  const { userId, pubSubBody } = message.body;

  try {
    const internalSecret = await env.INTERNAL_API_SECRET.get();

    // Look up machine status via service binding
    const statusRes = await env.KILOCLAW.fetch(
      new Request(`https://kiloclaw/api/platform/status?userId=${encodeURIComponent(userId)}`, {
        headers: { 'x-internal-api-key': internalSecret },
      })
    );

    if (!statusRes.ok) {
      console.warn(`[gmail-push] Status lookup failed for user ${userId}: ${statusRes.status}`);
      message.retry();
      return;
    }

    const status: {
      flyAppName: string | null;
      flyMachineId: string | null;
      sandboxId: string | null;
      status: string | null;
      gmailNotificationsEnabled: boolean;
    } = await statusRes.json();

    if (!status.flyAppName || !status.flyMachineId || status.status !== 'running') {
      console.warn(`[gmail-push] Machine not running for user ${userId}, retrying`);
      message.retry();
      return;
    }

    if (!status.gmailNotificationsEnabled) {
      console.log(`[gmail-push] Notifications disabled for user ${userId}, dropping message`);
      message.ack();
      return;
    }

    // Get gateway token
    const tokenRes = await env.KILOCLAW.fetch(
      new Request(
        `https://kiloclaw/api/platform/gateway-token?userId=${encodeURIComponent(userId)}`,
        { headers: { 'x-internal-api-key': internalSecret } }
      )
    );

    if (!tokenRes.ok) {
      console.error(
        `[gmail-push] Gateway token lookup failed for user ${userId}: ${tokenRes.status}`
      );
      message.retry();
      return;
    }

    const { gatewayToken }: { gatewayToken: string } = await tokenRes.json();

    // Forward push body to controller
    const machineUrl = `https://${status.flyAppName}.fly.dev`;
    const controllerRes = await fetch(`${machineUrl}/_kilo/gmail-pubsub`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${gatewayToken}`,
        'fly-force-instance-id': status.flyMachineId,
      },
      body: pubSubBody,
    });

    if (controllerRes.ok || (controllerRes.status >= 400 && controllerRes.status < 500)) {
      message.ack();
      await reportHistoryId(userId, pubSubBody, env, internalSecret);
      return;
    }

    console.error(`[gmail-push] Controller returned ${controllerRes.status} for user ${userId}`);
    message.retry();
  } catch (err) {
    console.error(`[gmail-push] Error delivering to user ${userId}:`, err);
    message.retry();
  }
}
