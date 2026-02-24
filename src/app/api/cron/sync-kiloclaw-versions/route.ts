import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { CRON_SECRET } from '@/lib/config.server';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { db } from '@/lib/drizzle';
import { kiloclaw_available_versions } from '@/db/schema';
import { sql, eq } from 'drizzle-orm';

/** Max new entries per sync run to avoid bulk-inserting unexpected data */
const MAX_NEW_PER_SYNC = 5;

/**
 * Vercel Cron Job: Sync KiloClaw Versions
 *
 * Fetches known image versions from the worker KV (via the internal API)
 * and upserts them into kiloclaw_available_versions. Deduplicates by image_tag.
 * Rejects entries whose digest already belongs to another tag.
 * Never overwrites admin-set status or notes.
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[sync-kiloclaw-versions] Starting sync...');

    const client = new KiloClawInternalClient();
    const { versions } = await client.listVersions();

    // Deduplicate by image_tag (keep the latest publishedAt per tag).
    // Duplicates indicate KV inconsistency — log them for debugging.
    const byTag = new Map<string, (typeof versions)[number]>();
    for (const v of versions) {
      const existing = byTag.get(v.imageTag);
      if (existing) {
        console.warn(
          `[sync-kiloclaw-versions] Duplicate image_tag "${v.imageTag}" in KV: ${existing.openclawVersion} vs ${v.openclawVersion}`
        );
        if (v.publishedAt > existing.publishedAt) {
          byTag.set(v.imageTag, v);
        }
      } else {
        byTag.set(v.imageTag, v);
      }
    }

    let inserted = 0;
    let updated = 0;
    let rejected = 0;

    for (const entry of byTag.values()) {
      // Reject entries whose digest already belongs to a different tag.
      // Same digest = same image. Two tags with the same digest is not allowed.
      if (entry.imageDigest) {
        const conflict = await db.query.kiloclaw_available_versions.findFirst({
          where: eq(kiloclaw_available_versions.image_digest, entry.imageDigest),
        });
        if (conflict && conflict.image_tag !== entry.imageTag) {
          console.warn(
            `[sync-kiloclaw-versions] Rejected "${entry.imageTag}": digest ${entry.imageDigest.slice(0, 16)}... already belongs to "${conflict.image_tag}"`
          );
          rejected++;
          continue;
        }
      }

      // Check if this tag already exists — needed to enforce insert rate limit
      // without skipping metadata updates for existing entries.
      const existing = await db.query.kiloclaw_available_versions.findFirst({
        where: eq(kiloclaw_available_versions.image_tag, entry.imageTag),
        columns: { id: true },
      });

      if (!existing && inserted >= MAX_NEW_PER_SYNC) {
        // New entry but rate limit reached — skip insert, continue processing updates
        continue;
      }

      const result = await db
        .insert(kiloclaw_available_versions)
        .values({
          openclaw_version: entry.openclawVersion,
          variant: entry.variant,
          image_tag: entry.imageTag,
          image_digest: entry.imageDigest,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: kiloclaw_available_versions.image_tag,
          set: {
            openclaw_version: entry.openclawVersion,
            variant: entry.variant,
            image_digest: entry.imageDigest,
          },
        })
        .returning({ isNew: sql<boolean>`(xmax = 0)` });

      if (result[0]?.isNew) {
        inserted++;
      } else {
        updated++;
      }
    }

    console.log(
      `[sync-kiloclaw-versions] Done: ${inserted} inserted, ${updated} updated, ${rejected} rejected from ${byTag.size} unique tags`
    );

    return NextResponse.json({ success: true, inserted, updated, rejected });
  } catch (err) {
    console.error('[sync-kiloclaw-versions] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
