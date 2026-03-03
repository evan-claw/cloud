import type { Hono } from 'hono';
import { zodJsonValidator, ApiMetricsParamsSchema } from '@kilocode/worker-utils';
import { writeApiMetricsDataPoint } from './o11y-analytics';
import { requireAdmin } from './admin-middleware';

export function registerApiMetricsRoutes(app: Hono<{ Bindings: Env }>): void {
	app.post('/ingest/api-metrics', requireAdmin, zodJsonValidator(ApiMetricsParamsSchema), async (c) => {
		const params = c.req.valid('json');
		writeApiMetricsDataPoint(params, 'kilo-gateway', c.env, (p) => c.executionCtx.waitUntil(p));
		return c.body(null, 204);
	});
}
