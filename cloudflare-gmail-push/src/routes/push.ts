import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoContext } from '../types';
import { validateOidcToken } from '../auth/oidc';

const PubSubMessageIdSchema = z.looseObject({
  message: z.looseObject({
    messageId: z.string(),
  }),
});

export const pushRoute = new Hono<HonoContext>();

pushRoute.post('/user/:userId', async c => {
  const userId = c.req.param('userId');

  // Validate Google OIDC token (mandatory).
  // Each user's Pub/Sub subscription uses a per-user audience that embeds the userId,
  // so the audience check implicitly binds the token to this specific user.
  const perUserAudience = `${c.env.OIDC_AUDIENCE_BASE}/push/user/${userId}`;
  const oidcResult = await validateOidcToken(c.req.header('authorization'), perUserAudience);
  if (!oidcResult.valid) {
    console.warn(`[gmail-push] OIDC validation failed for user ${userId}: ${oidcResult.error}`);
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Validate that the OIDC token's SA email matches the one stored for this user.
  // This prevents cross-project forgery: an attacker with their own GCP project
  // can get Google-signed tokens with a matching audience, but not with the
  // victim's service account email.
  const internalSecret = await c.env.INTERNAL_API_SECRET.get();
  const emailRes = await c.env.KILOCLAW.fetch(
    new Request(
      `https://kiloclaw/api/platform/gmail-oidc-email?userId=${encodeURIComponent(userId)}`,
      { headers: { 'x-internal-api-key': internalSecret } }
    )
  );

  if (!emailRes.ok) {
    console.error(`[gmail-push] OIDC email lookup failed for user ${userId}: ${emailRes.status}`);
    return c.json({ error: 'Service unavailable' }, 503);
  }

  const { gmailPushOidcEmail }: { gmailPushOidcEmail: string | null } = await emailRes.json();
  if (!gmailPushOidcEmail || oidcResult.email !== gmailPushOidcEmail) {
    console.warn(
      `[gmail-push] OIDC email mismatch for user ${userId}: got ${oidcResult.email}, expected ${gmailPushOidcEmail ?? '(not configured)'}`
    );
    return c.json({ error: 'Forbidden' }, 403);
  }

  const pubSubBody = await c.req.text();
  if (pubSubBody.length > 65_536) {
    return c.json({ error: 'Payload too large' }, 413);
  }

  // Extract Pub/Sub messageId for idempotency; fall back to a random UUID
  let messageId: string;
  try {
    const parsed = PubSubMessageIdSchema.safeParse(JSON.parse(pubSubBody));
    messageId = parsed.success ? parsed.data.message.messageId : crypto.randomUUID();
  } catch {
    messageId = crypto.randomUUID();
  }

  await c.env.GMAIL_PUSH_QUEUE.send({ userId, pubSubBody, messageId });

  return c.json({ ok: true }, 200);
});
