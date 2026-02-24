import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@/db/schema';
import { db } from '@/lib/drizzle';
import { kiloclaw_available_versions, kiloclaw_version_pins } from '@/db/schema';

// Mock the internal client to avoid calling the actual worker
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    publishImageVersion: jest.fn().mockResolvedValue({ ok: true, setLatest: true }),
  })),
}));

// Mock cron secret + app url
jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    CRON_SECRET: 'test-cron-secret',
  };
});

let adminUser: User;
let regularUser: User;
let targetUser: User;

beforeAll(async () => {
  adminUser = await insertTestUser({
    google_user_email: 'admin-versions@admin.example.com',
    google_user_name: 'Admin User',
    is_admin: true,
  });
  regularUser = await insertTestUser({
    google_user_email: 'regular-versions@example.com',
    google_user_name: 'Regular User',
    is_admin: false,
  });
  targetUser = await insertTestUser({
    google_user_email: 'target-user-versions@example.com',
    google_user_name: 'Target User',
    is_admin: false,
  });
});

afterEach(async () => {
  // eslint-disable-next-line drizzle/enforce-delete-with-where
  await db.delete(kiloclaw_version_pins);
  // eslint-disable-next-line drizzle/enforce-delete-with-where
  await db.delete(kiloclaw_available_versions);
});

describe('admin.kiloclawVersions', () => {
  describe('listVersions', () => {
    it('throws FORBIDDEN for non-admin', async () => {
      const caller = await createCallerForUser(regularUser.id);
      await expect(caller.admin.kiloclawVersions.listVersions({})).rejects.toThrow(
        'Admin access required'
      );
    });

    it('returns empty list when no versions exist', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.admin.kiloclawVersions.listVersions({});
      expect(result.versions).toEqual([]);
    });

    it('returns versions filtered by status', async () => {
      const caller = await createCallerForUser(adminUser.id);

      // Insert test versions directly
      await db.insert(kiloclaw_available_versions).values([
        {
          openclaw_version: '2026.2.1',
          variant: 'default',
          image_tag: 'dev-100',
          status: 'active',
        },
        {
          openclaw_version: '2026.1.0',
          variant: 'default',
          image_tag: 'dev-200',
          status: 'deprecated',
        },
      ]);

      const activeOnly = await caller.admin.kiloclawVersions.listVersions({ status: 'active' });
      expect(activeOnly.versions).toHaveLength(1);
      expect(activeOnly.versions[0].image_tag).toBe('dev-100');

      const all = await caller.admin.kiloclawVersions.listVersions({ status: 'all' });
      expect(all.versions).toHaveLength(2);
    });
  });

  describe('publishVersion', () => {
    it('upserts a version by image_tag', async () => {
      const caller = await createCallerForUser(adminUser.id);

      const v1 = await caller.admin.kiloclawVersions.publishVersion({
        openclawVersion: '2026.2.9',
        variant: 'default',
        imageTag: 'dev-123',
        setLatest: false,
      });
      expect(v1.image_tag).toBe('dev-123');
      expect(v1.openclaw_version).toBe('2026.2.9');

      // Upsert same tag with different version
      const v2 = await caller.admin.kiloclawVersions.publishVersion({
        openclawVersion: '2026.3.0',
        variant: 'default',
        imageTag: 'dev-123',
        setLatest: false,
      });
      expect(v2.id).toBe(v1.id); // same row
      expect(v2.openclaw_version).toBe('2026.3.0');
    });

    it('flips is_latest when setLatest is true', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await caller.admin.kiloclawVersions.publishVersion({
        openclawVersion: '2026.2.0',
        variant: 'default',
        imageTag: 'dev-old',
        setLatest: true,
      });

      await caller.admin.kiloclawVersions.publishVersion({
        openclawVersion: '2026.3.0',
        variant: 'default',
        imageTag: 'dev-new',
        setLatest: true,
      });

      const all = await caller.admin.kiloclawVersions.listVersions({});
      const old = all.versions.find(v => v.image_tag === 'dev-old');
      const latest = all.versions.find(v => v.image_tag === 'dev-new');
      expect(old?.is_latest).toBe(false);
      expect(latest?.is_latest).toBe(true);
    });
  });

  describe('updateVersionStatus', () => {
    it('updates status', async () => {
      const caller = await createCallerForUser(adminUser.id);

      const v = await caller.admin.kiloclawVersions.publishVersion({
        openclawVersion: '2026.2.0',
        variant: 'default',
        imageTag: 'dev-status',
        setLatest: false,
      });

      const updated = await caller.admin.kiloclawVersions.updateVersionStatus({
        id: v.id,
        status: 'deprecated',
      });
      expect(updated.status).toBe('deprecated');
    });
  });

  describe('pin CRUD', () => {
    it('pins a user to an active image tag', async () => {
      const caller = await createCallerForUser(adminUser.id);

      // Create a version first
      await caller.admin.kiloclawVersions.publishVersion({
        openclawVersion: '2026.2.9',
        variant: 'default',
        imageTag: 'dev-pin-test',
        setLatest: false,
      });

      const pin = await caller.admin.kiloclawVersions.pinUser({
        userId: targetUser.id,
        imageTag: 'dev-pin-test',
        reason: 'Testing',
      });
      expect(pin.user_id).toBe(targetUser.id);
      expect(pin.image_tag).toBe('dev-pin-test');
      expect(pin.reason).toBe('Testing');
    });

    it('rejects pinning to non-existent image tag', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await expect(
        caller.admin.kiloclawVersions.pinUser({
          userId: targetUser.id,
          imageTag: 'does-not-exist',
        })
      ).rejects.toThrow('not found in the version catalog');
    });

    it('upserts pin when pinning same user again', async () => {
      const caller = await createCallerForUser(adminUser.id);

      // Create two versions
      await db.insert(kiloclaw_available_versions).values([
        { openclaw_version: '2026.2.0', variant: 'default', image_tag: 'tag-a', status: 'active' },
        { openclaw_version: '2026.3.0', variant: 'default', image_tag: 'tag-b', status: 'active' },
      ]);

      await caller.admin.kiloclawVersions.pinUser({
        userId: targetUser.id,
        imageTag: 'tag-a',
      });

      await caller.admin.kiloclawVersions.pinUser({
        userId: targetUser.id,
        imageTag: 'tag-b',
        reason: 'Switched',
      });

      const { pin } = await caller.admin.kiloclawVersions.getPin({ userId: targetUser.id });
      expect(pin?.image_tag).toBe('tag-b');
      expect(pin?.reason).toBe('Switched');
    });

    it('unpins a user', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await db.insert(kiloclaw_available_versions).values({
        openclaw_version: '2026.2.0',
        variant: 'default',
        image_tag: 'tag-unpin',
        status: 'active',
      });

      await caller.admin.kiloclawVersions.pinUser({
        userId: targetUser.id,
        imageTag: 'tag-unpin',
      });

      const result = await caller.admin.kiloclawVersions.unpinUser({ userId: targetUser.id });
      expect(result.success).toBe(true);

      const { pin } = await caller.admin.kiloclawVersions.getPin({ userId: targetUser.id });
      expect(pin).toBeNull();
    });

    it('getPin returns version metadata', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await db.insert(kiloclaw_available_versions).values({
        openclaw_version: '2026.2.9',
        variant: 'default',
        image_tag: 'tag-meta',
        image_digest: 'sha256:abc123',
        status: 'active',
      });

      await caller.admin.kiloclawVersions.pinUser({
        userId: targetUser.id,
        imageTag: 'tag-meta',
      });

      const { pin, version } = await caller.admin.kiloclawVersions.getPin({
        userId: targetUser.id,
      });
      expect(pin?.image_tag).toBe('tag-meta');
      expect(version?.openclaw_version).toBe('2026.2.9');
      expect(version?.image_digest).toBe('sha256:abc123');
    });
  });

  describe('stats', () => {
    it('returns aggregate counts', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await db.insert(kiloclaw_available_versions).values([
        { openclaw_version: '2026.2.0', variant: 'default', image_tag: 's-1', status: 'active' },
        {
          openclaw_version: '2026.1.0',
          variant: 'default',
          image_tag: 's-2',
          status: 'deprecated',
        },
      ]);

      await db.insert(kiloclaw_version_pins).values({
        user_id: targetUser.id,
        image_tag: 's-1',
        pinned_by: adminUser.id,
      });

      const stats = await caller.admin.kiloclawVersions.stats();
      expect(stats.versions.total).toBe(2);
      expect(stats.versions.active).toBe(1);
      expect(stats.pins.total).toBe(1);
    });
  });
});
