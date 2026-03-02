import { Hono } from 'hono';
import { useWorkersLogger } from 'workers-tagged-logger';
import type { HonoContext } from './types';

const app = new Hono<HonoContext>();

app.use('*', useWorkersLogger('llm-gateway') as Parameters<typeof app.use>[1]);

// Phase 1 stub: all requests return 501 until middleware chain is wired up.
app.post('/chat/completions', c => {
  return c.json({ error: 'Not implemented' }, 501);
});

app.get('/health', c => {
  return c.json({ status: 'ok', service: 'llm-gateway' });
});

app.notFound(c => {
  return c.json({ error: 'Not found' }, 404);
});

app.onError((err, c) => {
  return c.json({ error: 'Internal server error', message: err.message }, 500);
});

export default {
  fetch: app.fetch,
};
