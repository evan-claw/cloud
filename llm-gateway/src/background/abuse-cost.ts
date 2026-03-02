// Background task: report upstream cost to the abuse service after usage is computed.
// Runs after runUsageAccounting so it has the final cost and token counts.

import { reportAbuseCost } from '../lib/abuse-service';
import type { AbuseServiceSecrets } from '../lib/abuse-service';
import type { MicrodollarUsageStats } from './usage-accounting';
import type { FraudDetectionHeaders } from '../lib/extract-headers';

export async function runAbuseCostReport(params: {
  serviceUrl: string;
  secrets: AbuseServiceSecrets | undefined;
  kiloUserId: string;
  fraudHeaders: FraudDetectionHeaders;
  requestedModel: string;
  abuseRequestId: number | undefined;
  usageStats: MicrodollarUsageStats;
}): Promise<void> {
  const {
    serviceUrl,
    secrets,
    kiloUserId,
    fraudHeaders,
    requestedModel,
    abuseRequestId,
    usageStats,
  } = params;

  // reportAbuseCost skips silently when abuseRequestId is missing/zero
  try {
    await reportAbuseCost(
      serviceUrl,
      secrets,
      {
        kiloUserId,
        fraudHeaders,
        requested_model: requestedModel,
        abuse_request_id: abuseRequestId,
      },
      {
        messageId: usageStats.messageId,
        cost_mUsd: usageStats.market_cost ?? usageStats.cost_mUsd,
        inputTokens: usageStats.inputTokens,
        outputTokens: usageStats.outputTokens,
        cacheWriteTokens: usageStats.cacheWriteTokens,
        cacheHitTokens: usageStats.cacheHitTokens,
      }
    );
  } catch (err) {
    console.error('[abuse-cost] Failed to report cost:', err);
  }
}
