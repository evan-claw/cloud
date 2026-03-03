import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';
import { validateFeatureHeader, FEATURE_HEADER } from '../lib/feature-detection';
import type { OpenRouterChatCompletionRequest } from '../types/request';
import { captureException } from '../lib/sentry';

export const parseBodyMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  let body: OpenRouterChatCompletionRequest;
  try {
    body = await c.req.json<OpenRouterChatCompletionRequest>();
  } catch (err) {
    captureException(err, { source: 'llm-gateway-parse-body' });
    return c.json(
      {
        error: 'Invalid request',
        message: 'Could not parse request body. Please ensure it is valid JSON.',
      },
      400
    );
  }

  // OpenRouter-specific field that we do not support
  delete body.models;

  if (typeof body.model !== 'string' || body.model.trim().length === 0) {
    return c.json(
      { error: 'Model not found', message: 'The requested model could not be found.' },
      404
    );
  }

  // Ensure usage is always returned so background accounting can parse it
  body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };

  const feature = validateFeatureHeader(c.req.header(FEATURE_HEADER) ?? null);
  const resolvedModel = body.model.trim().toLowerCase();

  c.set('requestBody', body);
  c.set('resolvedModel', resolvedModel);
  c.set('feature', feature);

  await next();
});
