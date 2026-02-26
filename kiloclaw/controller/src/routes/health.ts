import type { Context, Hono } from 'hono';
import type { Supervisor } from '../supervisor';

export function registerHealthRoute(app: Hono, supervisor: Supervisor): void {
  const handler = (c: Context) => {
    const stats = supervisor.getStats();
    const ready = stats.state === 'running';
    return c.json(
      {
        status: ready ? 'ok' : 'starting',
        gateway: stats.state,
        uptime: stats.uptime,
        restarts: stats.restarts,
      },
      ready ? 200 : 503
    );
  };

  app.get('/_kilo/health', handler);
  // Compatibility alias for machines still configured with legacy health path.
  app.get('/health', handler);
}
