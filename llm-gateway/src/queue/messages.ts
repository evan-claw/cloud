import type {
  MicrodollarUsageStats,
  MicrodollarUsageContext,
} from '../background/usage-accounting';
import type { ApiMetricsParams } from '@kilocode/worker-utils';
import type { FraudDetectionHeaders } from '../lib/extract-headers';

export type UsageAccountingMessage = {
  type: 'usage-accounting';
  idempotencyKey: string;
  usageStats: MicrodollarUsageStats;
  usageContext: Omit<MicrodollarUsageContext, 'providerApiKey'>;
  abuseRequestId: number | undefined;
  fraudHeaders: FraudDetectionHeaders;
  requested_model: string;
  kiloUserId: string;
  providerId: string;
};

export type ApiMetricsMessage = {
  type: 'api-metrics';
  idempotencyKey: string;
  params: ApiMetricsParams;
};

export type BackgroundTaskMessage = UsageAccountingMessage | ApiMetricsMessage;
