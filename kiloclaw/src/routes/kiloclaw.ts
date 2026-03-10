import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { SECRET_CATALOG } from '@kilocode/kiloclaw-secret-catalog';

/** Channel env var names — excluded from secretCount (channels have their own counts). */
const CHANNEL_ENV_VARS = new Set(
  SECRET_CATALOG.filter(e => e.category === 'channel').flatMap(e => e.fields.map(f => f.envVar))
);

/**
 * User-facing KiloClaw routes (JWT auth via authMiddleware).
 *
 * These routes allow a user to inspect their own instance via the
 * KiloClawInstance DO. They expose safe read-only views -- no secret
 * values, no lifecycle mutations (those go through /api/platform).
 */
const kiloclaw = new Hono<AppEnv>();

// GET /api/kiloclaw/config -- user's current env var keys, secret count, channel status
kiloclaw.get('/config', async c => {
  const userId = c.get('userId');
  const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));

  const config = await stub.getConfig();

  return c.json({
    envVarKeys: config.envVars ? Object.keys(config.envVars) : [],
    secretCount: config.encryptedSecrets
      ? Object.keys(config.encryptedSecrets).filter(k => !CHANNEL_ENV_VARS.has(k)).length
      : 0,
    kilocodeDefaultModel: config.kilocodeDefaultModel ?? null,
    hasKiloCodeApiKey: !!config.kilocodeApiKey,
    kilocodeApiKeyExpiresAt: config.kilocodeApiKeyExpiresAt ?? null,
    channels: {
      telegram: !!config.channels?.telegramBotToken,
      discord: !!config.channels?.discordBotToken,
      slackBot: !!config.channels?.slackBotToken,
      slackApp: !!config.channels?.slackAppToken,
    },
  });
});

// GET /api/kiloclaw/status -- user's instance status from the DO
kiloclaw.get('/status', async c => {
  const userId = c.get('userId');
  const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));

  const status = await stub.getStatus();

  return c.json(status);
});

export { kiloclaw };
