import { Hono } from 'hono';
import type { HonoContext } from '../types';
import { validateOidcToken } from '../auth/oidc';

export const pushRoute = new Hono<HonoContext>();

pushRoute.post('/user/:userId', async c => {
  const userId = c.req.param('userId');

  // Validate Google OIDC token
  const oidcResult = await validateOidcToken(c.req.header('authorization'), c.env.OIDC_AUDIENCE);

  if (!oidcResult.valid) {
    console.warn(`[gmail-push] OIDC validation failed for user ${userId}: ${oidcResult.error}`);
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    // Look up machine status via service binding
    const statusRes = await c.env.KILOCLAW.fetch(
      new Request(`https://kiloclaw/api/platform/status?userId=${encodeURIComponent(userId)}`, {
        headers: { 'x-internal-api-key': c.env.INTERNAL_API_SECRET },
      })
    );

    if (!statusRes.ok) {
      console.warn(`[gmail-push] Status lookup failed for user ${userId}: ${statusRes.status}`);
      return c.json({ ok: true, skipped: 'status-lookup-failed' }, 200);
    }

    const status: {
      flyAppName: string | null;
      flyMachineId: string | null;
      sandboxId: string | null;
      status: string | null;
    } = await statusRes.json();

    if (!status.flyAppName || !status.flyMachineId || status.status !== 'running') {
      return c.json({ ok: true, skipped: 'machine-not-running' }, 200);
    }

    // Get gateway token
    const tokenRes = await c.env.KILOCLAW.fetch(
      new Request(
        `https://kiloclaw/api/platform/gateway-token?userId=${encodeURIComponent(userId)}`,
        {
          headers: { 'x-internal-api-key': c.env.INTERNAL_API_SECRET },
        }
      )
    );

    if (!tokenRes.ok) {
      console.error(
        `[gmail-push] Gateway token lookup failed for user ${userId}: ${tokenRes.status}`
      );
      return c.json({ error: 'Token lookup failed' }, 500);
    }

    const tokenJson: { gatewayToken: string } = await tokenRes.json();
    const { gatewayToken } = tokenJson;

    // Forward push body to controller
    const machineUrl = `https://${status.flyAppName}.fly.dev`;
    const controllerRes = await fetch(`${machineUrl}/_kilo/gmail-pubsub`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${gatewayToken}`,
        'fly-force-instance-id': status.flyMachineId!,
      },
      body: c.req.raw.body,
    });

    if (controllerRes.ok || (controllerRes.status >= 400 && controllerRes.status < 500)) {
      return c.json({ ok: true }, 200);
    }

    console.error(`[gmail-push] Controller returned ${controllerRes.status} for user ${userId}`);
    return c.json({ error: 'Controller error' }, 500);
  } catch (err) {
    console.error(`[gmail-push] Error processing push for user ${userId}:`, err);
    return c.json({ error: 'Internal error' }, 500);
  }
});
