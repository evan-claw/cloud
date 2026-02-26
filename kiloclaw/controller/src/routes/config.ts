import fs from 'node:fs';
import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';

const CONFIG_PATH = '/root/.openclaw/openclaw.json';

/**
 * Deep-merge `patch` into `target`, creating intermediate objects as needed.
 * Arrays and primitives in the patch overwrite the target value.
 */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

export function registerConfigRoutes(app: Hono, expectedToken: string): void {
  app.use('/_kilo/config/*', async (c, next) => {
    const authHeader = c.req.header('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // Deep-merge a JSON patch into openclaw.json.
  // OpenClaw's gateway watches this file and reloads on change.
  //
  // Example: PATCH /_kilo/config/patch
  //   { "agents": { "defaults": { "model": { "primary": "kilocode/anthropic/claude-sonnet-4.5" } } } }
  app.post('/_kilo/config/patch', async c => {
    let patch: unknown;
    try {
      patch = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }

    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const config = JSON.parse(raw);
      deepMerge(config, patch as Record<string, unknown>);
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log('[controller] Config patched:', JSON.stringify(patch));
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[controller] Failed to patch config:', message);
      return c.json({ error: `Failed to patch config: ${message}` }, 500);
    }
  });
}
