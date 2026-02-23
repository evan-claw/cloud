import { db } from '@/lib/drizzle';
import { kiloclaw_available_versions, kiloclaw_version_pins } from '@/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@/db/schema';

// Capture what was passed to provision
const mockProvision = jest.fn().mockResolvedValue({ sandboxId: 'test-sandbox' });

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    provision: mockProvision,
    getStatus: jest.fn().mockResolvedValue({
      userId: null,
      sandboxId: null,
      status: null,
      provisionedAt: null,
      lastStartedAt: null,
      lastStoppedAt: null,
      envVarCount: 0,
      secretCount: 0,
      channelCount: 0,
      flyAppName: null,
      flyMachineId: null,
      flyVolumeId: null,
      flyRegion: null,
    }),
    getGatewayToken: jest.fn().mockResolvedValue({ gatewayToken: 'test-token' }),
  })),
}));

jest.mock('@/lib/kiloclaw/encryption', () => ({
  encryptKiloClawSecret: jest.fn((s: string) => ({
    encryptedData: `enc-${s}`,
    encryptedDEK: 'dek',
    algorithm: 'rsa-aes-256-gcm' as const,
    version: 1 as const,
  })),
}));

jest.mock('@/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/kiloclaw/instance-registry', () => ({
  ensureActiveInstance: jest.fn().mockResolvedValue(undefined),
  markActiveInstanceDestroyed: jest.fn(),
  restoreDestroyedInstance: jest.fn(),
}));

jest.mock('@/lib/tokens', () => ({
  generateApiToken: jest.fn().mockReturnValue('test-api-token'),
  TOKEN_EXPIRY: { thirtyDays: 2592000 },
}));

import { createCallerForUser } from '@/routers/test-utils';

let user: User;

beforeAll(async () => {
  user = await insertTestUser({
    google_user_email: 'pin-test-user@example.com',
    google_user_name: 'Pin Test User',
    is_admin: false,
  });
});

afterEach(async () => {
  // eslint-disable-next-line drizzle/enforce-delete-with-where
  await db.delete(kiloclaw_version_pins);
  // eslint-disable-next-line drizzle/enforce-delete-with-where
  await db.delete(kiloclaw_available_versions);
  mockProvision.mockClear();
});

describe('kiloclaw.provision with pinning', () => {
  it('passes pinnedImageTag to worker when user has a pin', async () => {
    // Set up catalog entry and pin
    await db.insert(kiloclaw_available_versions).values({
      openclaw_version: '2026.2.9',
      variant: 'default',
      image_tag: 'dev-pinned-tag',
      image_digest: 'sha256:abc123',
      status: 'active',
    });

    await db.insert(kiloclaw_version_pins).values({
      user_id: user.id,
      image_tag: 'dev-pinned-tag',
      pinned_by: user.id,
      reason: 'Test pin',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.provision({});

    expect(mockProvision).toHaveBeenCalledTimes(1);
    const [userId, provisionInput] = mockProvision.mock.calls[0];
    expect(userId).toBe(user.id);
    expect(provisionInput.pinnedImageTag).toBe('dev-pinned-tag');
    expect(provisionInput.pinnedImageDigest).toBe('sha256:abc123');
    expect(provisionInput.pinnedOpenclawVersion).toBe('2026.2.9');
    expect(provisionInput.pinnedVariant).toBe('default');
  });

  it('does not pass pinnedImageTag when user has no pin', async () => {
    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.provision({});

    expect(mockProvision).toHaveBeenCalledTimes(1);
    const [, provisionInput] = mockProvision.mock.calls[0];
    expect(provisionInput.pinnedImageTag).toBeUndefined();
    expect(provisionInput.pinnedImageDigest).toBeUndefined();
  });

  it('falls back to latest when pinned tag is not active', async () => {
    // Create a disabled version and pin to it
    await db.insert(kiloclaw_available_versions).values({
      openclaw_version: '2026.2.9',
      variant: 'default',
      image_tag: 'dev-disabled-tag',
      status: 'disabled',
    });

    await db.insert(kiloclaw_version_pins).values({
      user_id: user.id,
      image_tag: 'dev-disabled-tag',
      pinned_by: user.id,
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.provision({});

    expect(mockProvision).toHaveBeenCalledTimes(1);
    const [, provisionInput] = mockProvision.mock.calls[0];
    // Pin should be ignored because version is disabled
    expect(provisionInput.pinnedImageTag).toBeUndefined();
  });
});
