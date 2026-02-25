import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cacheLife } from 'next/cache';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/providers/openrouter';

async function getCachedModels() {
  'use cache';
  cacheLife({ revalidate: 60 });

  return getEnhancedOpenRouterModels();
}

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/openrouter/models'
 */
export async function GET(
  _request: NextRequest
): Promise<NextResponse<{ error: string; message: string } | OpenRouterModelsResponse>> {
  try {
    const data = await getCachedModels();
    return NextResponse.json(data);
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'openrouter/models' },
      extra: {
        action: 'fetching_models',
      },
    });
    return NextResponse.json(
      { error: 'Failed to fetch models', message: 'Error from OpenRouter API' },
      { status: 500 }
    );
  }
}
