/**
 * Tests for version pinning in KiloClawInstance DO.
 *
 * Verifies that:
 * - Pinned provisions use the pinned image tag directly (no KV lookup)
 * - Unpinned provisions resolve latest from KV (unchanged behavior)
 * - trackedImageDigest is persisted for pinned and unpinned paths
 * - Pinned metadata (version, variant) is passed through correctly
 */

import { describe, it, expect, vi } from 'vitest';

// -- Mock cloudflare:workers --
vi.mock('cloudflare:workers', () => ({
  DurableObject: class FakeDurableObject {
    ctx: { storage: unknown };
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx as { storage: unknown };
      this.env = env;
    }
  },
}));

// -- Mock fly client --
vi.mock('../fly/client', async () => {
  const { FlyApiError, isFlyNotFound, isFlyInsufficientResources } =
    await vi.importActual('../fly/client');
  return {
    FlyApiError,
    isFlyNotFound,
    isFlyInsufficientResources,
    createMachine: vi.fn(),
    getMachine: vi.fn(),
    startMachine: vi.fn(),
    stopMachine: vi.fn(),
    stopMachineAndWait: vi.fn(),
    destroyMachine: vi.fn(),
    waitForState: vi.fn(),
    updateMachine: vi.fn(),
    createVolume: vi.fn(),
    createVolumeWithFallback: vi.fn().mockResolvedValue({ id: 'vol-1', region: 'iad' }),
    deleteVolume: vi.fn(),
    getVolume: vi.fn(),
    listMachines: vi.fn().mockResolvedValue([]),
    listVolumeSnapshots: vi.fn().mockResolvedValue([]),
    execCommand: vi.fn(),
  };
});

// -- Mock db --
vi.mock('../db', () => ({
  createDatabaseConnection: vi.fn(),
  InstanceStore: vi.fn(),
}));

// -- Mock gateway/env --
vi.mock('../gateway/env', () => ({
  buildEnvVars: vi.fn().mockResolvedValue({
    env: { AUTO_APPROVE_DEVICES: 'true' },
    sensitive: { KILOCODE_API_KEY: 'test', OPENCLAW_GATEWAY_TOKEN: 'gw-token' },
  }),
}));

// -- Mock utils/env-encryption --
vi.mock('../utils/env-encryption', () => ({
  ENCRYPTED_ENV_PREFIX: 'KILOCLAW_ENC_',
  encryptEnvValue: vi.fn((_key: string, value: string) => `enc:v1:fake_${value}`),
}));

import { KiloClawInstance } from './kiloclaw-instance';

// ============================================================================
// Test harness
// ============================================================================

function createFakeStorage() {
  const store = new Map<string, unknown>();
  let alarmTime: number | null = null;

  return {
    get(keys: string[]): Map<string, unknown> {
      const result = new Map<string, unknown>();
      for (const k of keys) {
        if (store.has(k)) result.set(k, store.get(k));
      }
      return result;
    },
    put(entries: Record<string, unknown>): void {
      for (const [k, v] of Object.entries(entries)) {
        store.set(k, v);
      }
    },
    deleteAll(): void {
      store.clear();
      alarmTime = null;
    },
    setAlarm(time: number): void {
      alarmTime = time;
    },
    deleteAlarm(): void {
      alarmTime = null;
    },
    _store: store,
    _getAlarm: () => alarmTime,
  };
}

function createFakeAppStub() {
  return {
    ensureApp: vi.fn().mockResolvedValue({ appName: 'kiloclaw-user-1' }),
    ensureEnvKey: vi.fn().mockResolvedValue({
      key: 'dGVzdC1rZXktMzItYnl0ZXMtcGFkZGVkLi4uLg==',
      secretsVersion: 1,
    }),
  };
}

function createFakeEnv(kvGetResponse: unknown = null) {
  const appStub = createFakeAppStub();
  return {
    FLY_API_TOKEN: 'test-token',
    FLY_APP_NAME: 'test-app',
    FLY_REGION: 'us,eu',
    GATEWAY_TOKEN_SECRET: 'test-secret',
    KILOCLAW_INSTANCE: {} as unknown,
    KILOCLAW_APP: {
      idFromName: vi.fn().mockReturnValue('fake-do-id'),
      get: vi.fn().mockReturnValue(appStub),
    } as unknown,
    HYPERDRIVE: { connectionString: '' } as unknown,
    KV_CLAW_CACHE: {
      get: vi.fn().mockResolvedValue(kvGetResponse),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown,
  };
}

function createInstance(storage = createFakeStorage(), env = createFakeEnv()) {
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    storage,
    waitUntil: (p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    },
  } as unknown;
  const instance = new KiloClawInstance(
    ctx as ConstructorParameters<typeof KiloClawInstance>[0],
    env as ConstructorParameters<typeof KiloClawInstance>[1]
  );
  return { instance, storage, waitUntilPromises };
}

// ============================================================================
// Tests
// ============================================================================

describe('KiloClawInstance version pinning', () => {
  it('uses pinned image tag when pinOptions provided', async () => {
    const { instance, storage } = createInstance();

    await instance.provision(
      'user-1',
      {},
      {
        pinnedImageTag: 'dev-pinned-123',
        pinnedImageDigest: 'sha256:abc',
        pinnedOpenclawVersion: '2026.2.9',
        pinnedVariant: 'default',
      }
    );

    // Verify tracked fields in storage
    expect(storage._store.get('trackedImageTag')).toBe('dev-pinned-123');
    expect(storage._store.get('trackedImageDigest')).toBe('sha256:abc');
    expect(storage._store.get('openclawVersion')).toBe('2026.2.9');
    expect(storage._store.get('imageVariant')).toBe('default');
  });

  it('does not call KV resolveLatestVersion when pinned', async () => {
    const env = createFakeEnv();
    const { instance } = createInstance(createFakeStorage(), env);

    await instance.provision(
      'user-1',
      {},
      {
        pinnedImageTag: 'dev-pinned-456',
        pinnedOpenclawVersion: '2026.3.0',
        pinnedVariant: 'default',
      }
    );

    // KV should not have been read for latest version
    expect((env.KV_CLAW_CACHE as { get: ReturnType<typeof vi.fn> }).get).not.toHaveBeenCalled();
  });

  it('resolves from KV when no pin options provided', async () => {
    const kvEntry = {
      openclawVersion: '2026.2.9',
      variant: 'default',
      imageTag: 'dev-latest-789',
      imageDigest: 'sha256:kvdigest',
      publishedAt: '2026-02-20T00:00:00Z',
    };
    const env = createFakeEnv(kvEntry);
    const { instance, storage } = createInstance(createFakeStorage(), env);

    await instance.provision('user-1', {});

    // Should have read from KV
    expect((env.KV_CLAW_CACHE as { get: ReturnType<typeof vi.fn> }).get).toHaveBeenCalled();

    // Verify tracked fields from KV entry
    expect(storage._store.get('trackedImageTag')).toBe('dev-latest-789');
    expect(storage._store.get('trackedImageDigest')).toBe('sha256:kvdigest');
    expect(storage._store.get('openclawVersion')).toBe('2026.2.9');
    expect(storage._store.get('imageVariant')).toBe('default');
  });

  it('resolves from KV when pinOptions is empty object', async () => {
    const kvEntry = {
      openclawVersion: '2026.3.0',
      variant: 'default',
      imageTag: 'dev-empty-pin',
      imageDigest: null,
      publishedAt: '2026-02-20T00:00:00Z',
    };
    const env = createFakeEnv(kvEntry);
    const { instance, storage } = createInstance(createFakeStorage(), env);

    await instance.provision('user-1', {}, {});

    // No pinnedImageTag → falls back to KV
    expect(storage._store.get('trackedImageTag')).toBe('dev-empty-pin');
    expect(storage._store.get('trackedImageDigest')).toBeNull();
  });

  it('sets trackedImageDigest to null when pinned without digest', async () => {
    const { instance, storage } = createInstance();

    await instance.provision(
      'user-1',
      {},
      {
        pinnedImageTag: 'dev-no-digest',
        pinnedOpenclawVersion: '2026.2.0',
        pinnedVariant: 'default',
        // no pinnedImageDigest
      }
    );

    expect(storage._store.get('trackedImageTag')).toBe('dev-no-digest');
    expect(storage._store.get('trackedImageDigest')).toBeNull();
  });

  it('returns trackedImageDigest in getStatus', async () => {
    const { instance } = createInstance();

    await instance.provision(
      'user-1',
      {},
      {
        pinnedImageTag: 'dev-status-test',
        pinnedImageDigest: 'sha256:statusdigest',
        pinnedOpenclawVersion: '2026.2.9',
        pinnedVariant: 'default',
      }
    );

    const status = await instance.getStatus();
    expect(status.trackedImageTag).toBe('dev-status-test');
    expect(status.trackedImageDigest).toBe('sha256:statusdigest');
  });
});
