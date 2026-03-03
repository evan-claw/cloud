// Vercel AI Gateway A/B routing — port of src/lib/providers/vercel/index.ts (routing decision only).
// Determines whether a non-BYOK request should be routed to Vercel instead of OpenRouter.

import type { WorkerDb } from '@kilocode/db/client';
import { sql } from 'drizzle-orm';
import { isKiloFreeModel, preferredModels } from './models';
import { getKiloFreeModelWithGateway } from './providers';
import type { OpenRouterChatCompletionRequest } from '../types/request';

// Emergency switch — routes ALL eligible models to Vercel. Default: off.
const ENABLE_UNIVERSAL_VERCEL_ROUTING = false;

const ERROR_RATE_THRESHOLD = 0.5;

// Deterministic hash-based random in [0, 100) so the same user/task always gets
// the same routing decision.
async function getRandomNumberLessThan100(randomSeed: string): Promise<number> {
  const data = new TextEncoder().encode(randomSeed);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new DataView(hash).getUint32(0) % 100;
}

// Query the microdollar_usage_view for recent error rates per gateway.
// 500ms timeout, 60s cache (via the DB view), fail-open to 0/0.
export async function getGatewayErrorRate(
  db: WorkerDb
): Promise<{ openrouter: number; vercel: number }> {
  const fallback = { openrouter: 0, vercel: 0 };
  try {
    const result = await Promise.race([
      db.execute<{ gateway: string; errorRate: number }>(sql`
        select
          provider as "gateway",
          1.0 * count(*) filter(where has_error = true) / count(*) as "errorRate"
        from microdollar_usage_view
        where true
          and created_at >= now() - interval '10 minutes'
          and is_user_byok = false
          and provider in ('openrouter', 'vercel')
        group by provider
      `),
      scheduler.wait(500).then(() => 'timeout' as const),
    ]);
    if (result === 'timeout') {
      console.debug('[getGatewayErrorRate] query timeout');
      return fallback;
    }
    const rows = result.rows as unknown as Array<{ gateway: string; errorRate: number }>;
    return {
      openrouter: rows.find(r => r.gateway === 'openrouter')?.errorRate ?? 0,
      vercel: rows.find(r => r.gateway === 'vercel')?.errorRate ?? 0,
    };
  } catch (e) {
    console.debug('[getGatewayErrorRate] query error', e);
    return fallback;
  }
}

async function getVercelRoutingPercentage(db: WorkerDb): Promise<number> {
  const errorRate = await getGatewayErrorRate(db);
  const isOpenRouterErrorRateHigh =
    errorRate.openrouter > ERROR_RATE_THRESHOLD && errorRate.vercel < ERROR_RATE_THRESHOLD;
  if (isOpenRouterErrorRateHigh) {
    console.error(
      `[getVercelRoutingPercentage] OpenRouter error rate is high: ${errorRate.openrouter}`
    );
  }
  return isOpenRouterErrorRateHigh ? 90 : 10;
}

function isLikelyAvailableOnAllGateways(requestedModel: string): boolean {
  if (requestedModel.startsWith('openrouter/')) return false;
  // Kilo free models with a non-openrouter gateway (e.g. gigapotato, corethink, martian)
  // are not available on Vercel.
  if (isKiloFreeModel(requestedModel)) {
    const freeModel = getKiloFreeModelWithGateway(requestedModel);
    if (freeModel && freeModel.gateway !== 'OPENROUTER') return false;
  }
  return true;
}

export async function shouldRouteToVercel(
  db: WorkerDb,
  requestedModel: string,
  request: OpenRouterChatCompletionRequest,
  randomSeed: string
): Promise<boolean> {
  if (request.provider?.data_collection === 'deny') {
    console.debug('[shouldRouteToVercel] not routing: data_collection=deny not supported');
    return false;
  }

  if (!isLikelyAvailableOnAllGateways(requestedModel)) {
    console.debug('[shouldRouteToVercel] model not available on all gateways');
    return false;
  }

  if (ENABLE_UNIVERSAL_VERCEL_ROUTING) {
    console.debug('[shouldRouteToVercel] universal Vercel routing enabled');
    return true;
  }

  // Anthropic models excluded pending fine-grained tool streaming support
  if (requestedModel.startsWith('anthropic/')) {
    console.debug('[shouldRouteToVercel] Anthropic models excluded');
    return false;
  }

  if (!preferredModels.includes(requestedModel)) {
    console.debug('[shouldRouteToVercel] only preferred models are tested for Vercel routing');
    return false;
  }

  console.debug('[shouldRouteToVercel] randomizing to OpenRouter or Vercel');
  return (
    (await getRandomNumberLessThan100('vercel_routing_' + randomSeed)) <
    (await getVercelRoutingPercentage(db))
  );
}
