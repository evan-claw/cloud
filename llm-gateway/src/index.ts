import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { useWorkersLogger } from 'workers-tagged-logger';
import type { HonoContext } from './types/hono';
import { requestTimingMiddleware } from './middleware/request-timing';
import { parseBodyMiddleware } from './middleware/parse-body';
import { extractIpMiddleware } from './middleware/extract-ip';
import { resolveAutoModelMiddleware } from './middleware/resolve-auto-model';
import { authMiddleware } from './middleware/auth';
import { anonymousGateMiddleware } from './middleware/anonymous-gate';
import { freeModelRateLimitMiddleware } from './middleware/free-model-rate-limit';
import { promotionLimitMiddleware } from './middleware/promotion-limit';
import { logFreeModelUsageMiddleware } from './middleware/log-free-model-usage';
import { providerResolutionMiddleware } from './middleware/provider-resolution';

const app = new Hono<HonoContext>();

app.use('*', useWorkersLogger('llm-gateway') as Parameters<typeof app.use>[1]);

// Stub handler replaced by proxyHandler in Phase 5
const notImplemented: MiddlewareHandler<HonoContext> = async c =>
  c.json({ error: 'Not implemented' }, 501);

function registerChatCompletions(path: string) {
  app.post(
    path,
    requestTimingMiddleware,
    parseBodyMiddleware,
    extractIpMiddleware,
    resolveAutoModelMiddleware,
    authMiddleware,
    anonymousGateMiddleware,
    freeModelRateLimitMiddleware,
    promotionLimitMiddleware,
    logFreeModelUsageMiddleware,
    providerResolutionMiddleware,
    // Remaining middleware (request validation, balance, transform, proxy) added in later phases.
    notImplemented
  );
}

// Match the Next.js routes exactly so clients need no URL reconfiguration
registerChatCompletions('/api/gateway/chat/completions');
registerChatCompletions('/api/openrouter/chat/completions');

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
