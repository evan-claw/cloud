import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cacheLife } from 'next/cache';
import { db } from '@/lib/drizzle';
import { modelStats } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';

async function getModelStatBySlug(slug: string) {
  'use cache';
  cacheLife({ revalidate: 3600 });

  const [stat] = await db.select().from(modelStats).where(eq(modelStats.slug, slug)).limit(1);
  return stat ?? null;
}

/**
 * GET /api/models/stats/[slug]
 * Returns model statistics for a specific model by slug
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const stat = await getModelStatBySlug(slug);

    if (!stat) {
      return NextResponse.json({ error: `Model with slug "${slug}" not found` }, { status: 404 });
    }

    return NextResponse.json(stat);
  } catch (error) {
    console.error('Error fetching model stat by slug:', error);
    captureException(error, {
      tags: { endpoint: 'api/models/stats/[slug]' },
    });

    return NextResponse.json({ error: 'Failed to fetch model statistics' }, { status: 500 });
  }
}
