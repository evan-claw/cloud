import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (p: Promise<unknown>) => p,
}));

const testUserId = 'user-1';
const testAppName = 'acct-abc123';
const testMachineId = 'd890abc123';

function makeEnv(overrides: Record<string, unknown> = {}) {
  const forceRetryRecovery = vi.fn().mockResolvedValue(undefined);
  return {
    env: {
      FLY_API_TOKEN: 'fly-test-token',
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ forceRetryRecovery }),
      },
      KILOCLAW_AE: { writeDataPoint: vi.fn() },
      KV_CLAW_CACHE: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
        getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
      },
      ...overrides,
    } as never,
    forceRetryRecovery,
  };
}

function postJson(path: string, body: Record<string, unknown>) {
  return {
    path,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

describe('POST /destroy-fly-machine', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 and calls Fly API DELETE with force=true', async () => {
    const { env } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json).toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledWith(
      `https://api.machines.dev/v1/apps/${testAppName}/machines/${testMachineId}?force=true`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer fly-test-token' },
      }
    );
  });

  it('builds Fly API URL with literal appName and machineId (no URI encoding needed)', async () => {
    const { env } = makeEnv();
    const appNameWithHyphen = 'acct-abc-123';
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: appNameWithHyphen,
      machineId: testMachineId,
    });
    await platform.request(path, init, env);

    // Zod schema restricts appName to /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/ and machineId to
    // /^[a-z0-9]+$/ — characters that never need URL-encoding, so no encodeURIComponent is needed.
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://api.machines.dev/v1/apps/${appNameWithHyphen}/machines/${testMachineId}?force=true`,
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('triggers forceRetryRecovery after successful destroy', async () => {
    const { env, forceRetryRecovery } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });
    await platform.request(path, init, env);

    expect(forceRetryRecovery).toHaveBeenCalled();
  });

  it('returns 503 when FLY_API_TOKEN is not configured', async () => {
    const { env } = makeEnv({ FLY_API_TOKEN: undefined });
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(503);
    const json = await resp.json();
    expect(json.error).toContain('FLY_API_TOKEN');
  });

  it('wraps Fly API error status and body in error message', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('machine not found', { status: 404 }));
    const { env } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(404);
    const json = await resp.json();
    // Implementation wraps the Fly response body: "Fly API error (${status}): ${body}"
    expect(json.error).toBe('Fly API error (404): machine not found');
  });

  it('returns 400 for invalid appName format', async () => {
    const { env } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: 'INVALID',
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid machineId format', async () => {
    const { env } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: 'BAD-ID!',
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for missing userId', async () => {
    const { env } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      appName: testAppName,
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still returns ok when forceRetryRecovery fails', async () => {
    const forceRetryRecovery = vi.fn().mockRejectedValue(new Error('DO unavailable'));
    const { env } = makeEnv({
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ forceRetryRecovery }),
      },
    });
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json).toEqual({ ok: true });
    expect(forceRetryRecovery).toHaveBeenCalled();
  });
});
