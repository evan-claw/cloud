import type { Env, GmailPushQueueMessage } from './types';

export async function handleQueue(
  batch: MessageBatch<GmailPushQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    await processMessage(message, env);
  }
}

async function processMessage(
  message: Message<GmailPushQueueMessage>,
  env: Env
): Promise<void> {
  const { userId, pubSubBody } = message.body;

  try {
    // Look up machine status via service binding
    const statusRes = await env.KILOCLAW.fetch(
      new Request(`https://kiloclaw/api/platform/status?userId=${encodeURIComponent(userId)}`, {
        headers: { 'x-internal-api-key': env.INTERNAL_API_SECRET },
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
    } = await statusRes.json();

    if (!status.flyAppName || !status.flyMachineId || status.status !== 'running') {
      console.warn(`[gmail-push] Machine not running for user ${userId}, retrying`);
      message.retry();
      return;
    }

    // Get gateway token
    const tokenRes = await env.KILOCLAW.fetch(
      new Request(
        `https://kiloclaw/api/platform/gateway-token?userId=${encodeURIComponent(userId)}`,
        { headers: { 'x-internal-api-key': env.INTERNAL_API_SECRET } }
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
      return;
    }

    console.error(`[gmail-push] Controller returned ${controllerRes.status} for user ${userId}`);
    message.retry();
  } catch (err) {
    console.error(`[gmail-push] Error delivering to user ${userId}:`, err);
    message.retry();
  }
}
