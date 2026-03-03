import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { ApiMetricsParamsSchema, SessionMetricsParamsSchema } from '@kilocode/worker-utils';
import type { ApiMetricsParams, SessionMetricsParams } from '@kilocode/worker-utils';
import { registerApiMetricsRoutes } from './api-metrics-routes';
import { evaluateAlerts } from './alerting/evaluate';
import { registerAlertingConfigRoutes } from './alerting/config-routes';
import { writeSessionMetricsDataPoint } from './session-metrics-analytics';
import { writeApiMetricsDataPoint } from './o11y-analytics';

export { AlertConfigDO } from './alerting/AlertConfigDO';

const app = new Hono<{ Bindings: Env }>();

registerApiMetricsRoutes(app);
registerAlertingConfigRoutes(app);

export default class extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		return app.fetch(request, this.env, this.ctx);
	}

	async scheduled(_controller: ScheduledController): Promise<void> {
		await evaluateAlerts(this.env);
	}

	/** RPC method called by session-ingest via service binding. */
	async ingestSessionMetrics(params: SessionMetricsParams): Promise<void> {
		const parsed = SessionMetricsParamsSchema.parse(params);
		await writeSessionMetricsDataPoint(parsed, this.env);
	}

	/** RPC method called by llm-gateway via service binding. */
	async ingestApiMetrics(params: ApiMetricsParams): Promise<void> {
		const parsed = ApiMetricsParamsSchema.parse(params);
		writeApiMetricsDataPoint(parsed, 'kilo-gateway', this.env, (p) => this.ctx.waitUntil(p));
	}
}
