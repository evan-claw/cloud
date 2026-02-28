import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq } from 'drizzle-orm';
import migrations from '../../drizzle/migrations';
import { alertConfig, ttfbAlertConfig } from '../db/sqlite-schema';
import type { AlertingConfig } from './config-store';
import type { TtfbAlertingConfig } from './ttfb-config-store';

function rowToConfig(row: typeof alertConfig.$inferSelect): AlertingConfig {
	return {
		model: row.model,
		enabled: row.enabled === 1,
		errorRateSlo: row.error_rate_slo,
		minRequestsPerWindow: row.min_requests_per_window,
		updatedAt: row.updated_at,
	};
}

function rowToTtfbConfig(row: typeof ttfbAlertConfig.$inferSelect): TtfbAlertingConfig {
	return {
		model: row.model,
		enabled: row.enabled === 1,
		ttfbThresholdMs: row.ttfb_threshold_ms,
		ttfbSlo: row.ttfb_slo,
		minRequestsPerWindow: row.min_requests_per_window,
		updatedAt: row.updated_at,
	};
}

export class AlertConfigDO extends DurableObject<Env> {
	private db;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { logger: false });
		void ctx.blockConcurrencyWhile(async () => {
			migrate(this.db, migrations);
		});
	}

	list(): AlertingConfig[] {
		return this.db.select().from(alertConfig).orderBy(alertConfig.model).all().map(rowToConfig);
	}

	get(model: string): AlertingConfig | null {
		const rows = this.db.select().from(alertConfig).where(eq(alertConfig.model, model)).all();
		if (rows.length === 0) return null;
		return rowToConfig(rows[0]);
	}

	upsert(config: AlertingConfig): void {
		this.db
			.insert(alertConfig)
			.values({
				model: config.model,
				enabled: config.enabled ? 1 : 0,
				error_rate_slo: config.errorRateSlo,
				min_requests_per_window: config.minRequestsPerWindow,
				updated_at: config.updatedAt,
			})
			.onConflictDoUpdate({
				target: alertConfig.model,
				set: {
					enabled: config.enabled ? 1 : 0,
					error_rate_slo: config.errorRateSlo,
					min_requests_per_window: config.minRequestsPerWindow,
					updated_at: config.updatedAt,
				},
			})
			.run();
	}

	remove(model: string): void {
		this.db.delete(alertConfig).where(eq(alertConfig.model, model)).run();
	}

	listTtfb(): TtfbAlertingConfig[] {
		return this.db.select().from(ttfbAlertConfig).orderBy(ttfbAlertConfig.model).all().map(rowToTtfbConfig);
	}

	getTtfb(model: string): TtfbAlertingConfig | null {
		const rows = this.db.select().from(ttfbAlertConfig).where(eq(ttfbAlertConfig.model, model)).all();
		if (rows.length === 0) return null;
		return rowToTtfbConfig(rows[0]);
	}

	upsertTtfb(config: TtfbAlertingConfig): void {
		this.db
			.insert(ttfbAlertConfig)
			.values({
				model: config.model,
				enabled: config.enabled ? 1 : 0,
				ttfb_threshold_ms: config.ttfbThresholdMs,
				ttfb_slo: config.ttfbSlo,
				min_requests_per_window: config.minRequestsPerWindow,
				updated_at: config.updatedAt,
			})
			.onConflictDoUpdate({
				target: ttfbAlertConfig.model,
				set: {
					enabled: config.enabled ? 1 : 0,
					ttfb_threshold_ms: config.ttfbThresholdMs,
					ttfb_slo: config.ttfbSlo,
					min_requests_per_window: config.minRequestsPerWindow,
					updated_at: config.updatedAt,
				},
			})
			.run();
	}

	removeTtfb(model: string): void {
		this.db.delete(ttfbAlertConfig).where(eq(ttfbAlertConfig.model, model)).run();
	}
}

type AlertConfigDOEnv = {
	ALERT_CONFIG_DO: DurableObjectNamespace<AlertConfigDO>;
};

export function getAlertConfigDO(env: AlertConfigDOEnv): DurableObjectStub<AlertConfigDO> {
	const id = env.ALERT_CONFIG_DO.idFromName('global');
	return env.ALERT_CONFIG_DO.get(id);
}
