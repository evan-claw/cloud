import type { ApiMetricsParams } from '@kilocode/worker-utils';

export type O11YBinding = Fetcher & {
  ingestApiMetrics(params: ApiMetricsParams): Promise<void>;
};
