import type { SessionMetricsParams } from '@kilocode/worker-utils';

export type O11YBinding = Fetcher & {
  ingestSessionMetrics(params: SessionMetricsParams): Promise<void>;
};
