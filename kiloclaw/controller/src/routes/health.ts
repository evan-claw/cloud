import { execFile } from 'node:child_process';
import type { Context, Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import type { Supervisor } from '../supervisor';
import type { ControllerStateRef } from '../bootstrap';
import { CONTROLLER_COMMIT, CONTROLLER_VERSION } from '../version';
import { getBearerToken } from './gateway';

/** Parsed result from `openclaw --version` (e.g. "OpenClaw 2026.3.8 (3caab92)"). */
type OpenclawVersionInfo = { version: string | null; commit: string | null };

const OPENCLAW_VERSION_RE = /(\d{4}\.\d{1,2}\.\d{1,2})(?:\s+\(([0-9a-f]+)\))?/;

export function parseOpenclawVersion(raw: string): OpenclawVersionInfo {
  const match = raw.match(OPENCLAW_VERSION_RE);
  if (!match) return { version: null, commit: null };
  return { version: match[1], commit: match[2] ?? null };
}

/**
 * Resolve the installed openclaw version once and cache it for the process lifetime.
 * If the user upgrades openclaw while the controller is running, the cached value
 * becomes stale until the next redeploy (which restarts the controller process).
 * This is acceptable: the UI shows a "Modified" badge by comparing image vs running
 * version, and spawning a subprocess on every request is not worth the cost.
 */
let openclawVersionPromise: Promise<OpenclawVersionInfo> | undefined;
function getOpenclawVersion(): Promise<OpenclawVersionInfo> {
  if (!openclawVersionPromise) {
    openclawVersionPromise = new Promise(resolve => {
      execFile(
        '/usr/bin/env',
        ['HOME=/root', 'openclaw', '--version'],
        { timeout: 5000 },
        (err, stdout) => {
          if (err) {
            resolve({ version: null, commit: null });
          } else {
            resolve(parseOpenclawVersion(stdout.toString().trim()));
          }
        }
      );
    });
  }
  return openclawVersionPromise;
}

export function registerHealthRoute(
  app: Hono,
  supervisor: Supervisor | null,
  expectedToken?: string,
  stateRef?: ControllerStateRef
): void {
  // Eagerly resolve so the first /_kilo/version request doesn't wait on the subprocess.
  void getOpenclawVersion();

  // /_kilo/health: returns controller lifecycle state for the CF worker.
  // Always returns HTTP 200 + status: 'ok' so Fly health probes stay happy.
  // Gateway process state is available separately via /_kilo/gateway/status (auth-gated).
  app.get('/_kilo/health', (c: Context) => {
    if (stateRef) {
      const s = stateRef.current;
      const base = { status: 'ok' as const };
      if (s.state === 'bootstrapping') {
        return c.json({ ...base, state: s.state, phase: s.phase });
      }
      if (s.state === 'degraded') {
        return c.json({ ...base, state: s.state, error: s.error });
      }
      return c.json({ ...base, state: s.state });
    }
    return c.json({ status: 'ok' });
  });

  // Bare /health for Fly probes — no state details, always 200.
  app.get('/health', (c: Context) => c.json({ status: 'ok' }));

  // Authenticated version/diagnostics endpoint.
  app.get('/_kilo/version', async c => {
    if (expectedToken) {
      const token = getBearerToken(c.req.header('authorization'));
      if (!timingSafeTokenEqual(token, expectedToken)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    const openclaw = await getOpenclawVersion();
    return c.json({
      version: CONTROLLER_VERSION,
      commit: CONTROLLER_COMMIT,
      openclawVersion: openclaw.version,
      openclawCommit: openclaw.commit,
      gateway: supervisor?.getStats() ?? null,
      ...(stateRef ? { controllerState: stateRef.current } : {}),
    });
  });
}
