import { NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { kiloclaw_available_versions } from '@/db/schema';
import { eq } from 'drizzle-orm';

const mockListVersions = jest.fn();

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    listVersions: mockListVersions,
  })),
}));

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual<typeof import('@/lib/config.server')>('@/lib/config.server'),
  CRON_SECRET: 'test-cron-secret',
  KILOCLAW_API_URL: 'http://localhost:8787',
  KILOCLAW_INTERNAL_API_SECRET: 'test-secret',
}));

import { GET } from './route';

afterEach(async () => {
  // eslint-disable-next-line drizzle/enforce-delete-with-where
  await db.delete(kiloclaw_available_versions);
  mockListVersions.mockReset();
});

function makeRequest(authHeader?: string) {
  return new NextRequest('http://localhost/api/cron/sync-kiloclaw-versions', {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe('sync-kiloclaw-versions cron', () => {
  it('returns 401 without valid auth', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong secret', async () => {
    const res = await GET(makeRequest('Bearer wrong'));
    expect(res.status).toBe(401);
  });

  it('inserts new versions from worker KV', async () => {
    mockListVersions.mockResolvedValue({
      versions: [
        {
          openclawVersion: '2026.2.0',
          variant: 'default',
          imageTag: 'dev-100',
          imageDigest: 'sha256:aaa',
          publishedAt: '2026-02-01T00:00:00Z',
        },
        {
          openclawVersion: '2026.3.0',
          variant: 'default',
          imageTag: 'dev-200',
          imageDigest: null,
          publishedAt: '2026-02-15T00:00:00Z',
        },
      ],
    });

    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.inserted).toBe(2);

    // Verify in DB
    const rows = await db.select().from(kiloclaw_available_versions);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.image_tag).sort()).toEqual(['dev-100', 'dev-200']);
  });

  it('updates existing versions without overwriting status', async () => {
    // Pre-insert a version with deprecated status
    await db.insert(kiloclaw_available_versions).values({
      openclaw_version: '2026.2.0',
      variant: 'default',
      image_tag: 'dev-existing',
      status: 'deprecated',
      notes: 'Admin note',
    });

    mockListVersions.mockResolvedValue({
      versions: [
        {
          openclawVersion: '2026.2.1', // updated version
          variant: 'default',
          imageTag: 'dev-existing',
          imageDigest: 'sha256:new',
          publishedAt: '2026-02-20T00:00:00Z',
        },
      ],
    });

    const res = await GET(makeRequest('Bearer test-cron-secret'));
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(body.inserted).toBe(0);

    // Verify admin-set fields preserved
    const [row] = await db
      .select()
      .from(kiloclaw_available_versions)
      .where(eq(kiloclaw_available_versions.image_tag, 'dev-existing'));
    expect(row.status).toBe('deprecated'); // not overwritten
    expect(row.notes).toBe('Admin note'); // not overwritten
    expect(row.openclaw_version).toBe('2026.2.1'); // updated
    expect(row.image_digest).toBe('sha256:new'); // updated
  });

  it('deduplicates by image_tag, keeping latest publishedAt', async () => {
    mockListVersions.mockResolvedValue({
      versions: [
        {
          openclawVersion: '2026.2.0',
          variant: 'default',
          imageTag: 'dev-dup',
          imageDigest: null,
          publishedAt: '2026-02-01T00:00:00Z',
        },
        {
          openclawVersion: '2026.2.1',
          variant: 'default',
          imageTag: 'dev-dup',
          imageDigest: 'sha256:newer',
          publishedAt: '2026-02-15T00:00:00Z',
        },
      ],
    });

    await GET(makeRequest('Bearer test-cron-secret'));

    const rows = await db
      .select()
      .from(kiloclaw_available_versions)
      .where(eq(kiloclaw_available_versions.image_tag, 'dev-dup'));
    expect(rows).toHaveLength(1);
    expect(rows[0].openclaw_version).toBe('2026.2.1');
    expect(rows[0].image_digest).toBe('sha256:newer');
  });

  it('rate limits new entries to 5 per sync', async () => {
    mockListVersions.mockResolvedValue({
      versions: Array.from({ length: 10 }, (_, i) => ({
        openclawVersion: `2026.${i}.0`,
        variant: 'default',
        imageTag: `dev-rl-${i}`,
        imageDigest: null,
        publishedAt: new Date(2026, 1, i + 1).toISOString(),
      })),
    });

    const res = await GET(makeRequest('Bearer test-cron-secret'));
    const body = await res.json();
    expect(body.inserted).toBe(5);

    const rows = await db.select().from(kiloclaw_available_versions);
    expect(rows).toHaveLength(5);
  });
});
