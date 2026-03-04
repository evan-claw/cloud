import type { MicrodollarUsageStats, MicrodollarUsageContext } from '../background/usage-accounting';
import type { ApiMetricsParams } from '@kilocode/worker-utils';
import type { AbuseServiceSecrets } from '../lib/abuse-service';
import type { FraudDetectionHeaders } from '../lib/extract-headers';

export type UsageAccountingMessage = {
  type: 'usage-accounting';
  usageStats: MicrodollarUsageStats;
  usageContext: Omit<MicrodollarUsageContext, 'providerApiKey'>;
  abuseRequestId: number | undefined;
  abuseServiceUrl: string;
  abuseSecrets: AbuseServiceSecrets | undefined;
  fraudHeaders: FraudDetectionHeaders;
  requested_model: string;
  kiloUserId: string;
  connectionString: string;
  providerId: string;
};

export type ApiMetricsMessage = {
  type: 'api-metrics';
  params: ApiMetricsParams;
};

export type BackgroundTaskMessage = UsageAccountingMessage | ApiMetricsMessage;
