import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/providers/openrouter';
import { getUserFromAuth } from '@/lib/user.server';
import { getCodingPlanModelsForUser } from '@/lib/providers/coding-plans';

async function getCodingPlanModels() {
  try {
    const { user } = await getUserFromAuth({ adminOnly: false });
    if (user) {
      console.debug('[getCodingPlanModels] authenticated request, fetching coding plan models');
      return await getCodingPlanModelsForUser(user.id);
    } else {
      console.debug('[getCodingPlanModels] anonymous request, no coding plan models');
      return [];
    }
  } catch (e) {
    console.debug('[getCodingPlanModels] error, database unavailable?', e);
    return [];
  }
}

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/openrouter/models'
 */
export async function GET(
  _request: NextRequest
): Promise<NextResponse<{ error: string; message: string } | OpenRouterModelsResponse>> {
  try {
    const data = await getEnhancedOpenRouterModels();
    return NextResponse.json({ data: data.data.concat(await getCodingPlanModels()) });
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
