export { RateLimitDO } from './dos/RateLimitDO';
import * as Sentry from '@sentry/cloudflare';
import { SENTRY_DSN } from './lib/sentry';
import { handleBackgroundTaskQueue } from './queue/consumer';
import type { BackgroundTaskMessage } from './queue/messages';
import type { Env } from './env';
import { Hono } from 'hono';
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
import { requestValidationMiddleware } from './middleware/request-validation';
import { balanceAndOrgCheckMiddleware } from './middleware/balance-and-org';
import { requestTransformMiddleware } from './middleware/request-transform';
import { proxyHandler } from './handler/proxy';
import { captureException } from './lib/sentry';

const app = new Hono<HonoContext>();

app.use('*', useWorkersLogger('llm-gateway') as Parameters<typeof app.use>[1]);

function registerChatCompletions(path: string) {
  app.post(
    path,
    requestTimingMiddleware,
    parseBodyMiddleware,
    extractIpMiddleware,
    resolveAutoModelMiddleware,
    freeModelRateLimitMiddleware,
    authMiddleware,
    anonymousGateMiddleware,
    promotionLimitMiddleware,
    logFreeModelUsageMiddleware,
    providerResolutionMiddleware,
    requestValidationMiddleware,
    balanceAndOrgCheckMiddleware,
    requestTransformMiddleware,
    proxyHandler
  );
}

// Match the Next.js routes exactly so clients need no URL reconfiguration
registerChatCompletions('/api/gateway/chat/completions');
registerChatCompletions('/api/openrouter/chat/completions');

app.notFound(c => {
  const path = new URL(c.req.url).pathname;
  // The reference validates that [...path] is /chat/completions and returns
  // invalidPathResponse() for anything else under /api/gateway or /api/openrouter.
  if (path.startsWith('/api/gateway/') || path.startsWith('/api/openrouter/')) {
    return c.json(
      {
        error: 'Invalid path',
        message: 'This endpoint only accepts the path `/chat/completions`.',
      },
      400
    );
  }
  return c.json({ error: 'Not found' }, 404);
});

app.onError((err, c) => {
  console.error('[llm-gateway] Unhandled error', err);
  captureException(err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default Sentry.withSentry<Env, BackgroundTaskMessage>(
  (_env: Env) => ({
    dsn: SENTRY_DSN,
    sendDefaultPii: true,
  }),
  { fetch: app.fetch, queue: handleBackgroundTaskQueue }
);
