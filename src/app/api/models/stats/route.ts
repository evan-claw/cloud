import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cacheLife } from 'next/cache';
import { db } from '@/lib/drizzle';
import { modelStats } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';

async function getActiveModelStats() {
  'use cache';
  cacheLife({ revalidate: 3600 });

  return db
    .select()
    .from(modelStats)
    .where(eq(modelStats.isActive, true))
    .orderBy(desc(modelStats.codingIndex));
}

/**
 * GET /api/models/stats
 * Returns all active model statistics
 */
export async function GET(_request: NextRequest) {
  try {
    const stats = await getActiveModelStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error('Error fetching model stats:', error);
    captureException(error, {
      tags: { endpoint: 'api/models/stats' },
    });

    return NextResponse.json({ error: 'Failed to fetch model statistics' }, { status: 500 });
  }
}
