import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';
import { isFreeModel } from '../lib/models';
import { createAnonymousContext } from '../lib/anonymous';

const PAID_MODEL_AUTH_REQUIRED = 'PAID_MODEL_AUTH_REQUIRED';

export const anonymousGateMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const authUser = c.get('authUser');

  if (authUser !== undefined) {
    // Successfully authenticated — wire up the shared `user` variable
    c.set('user', authUser);
    return next();
  }

  // Auth failed or no token — decide based on model
  const resolvedModel = c.get('resolvedModel');

  if (!isFreeModel(resolvedModel)) {
    return c.json(
      {
        error: {
          code: PAID_MODEL_AUTH_REQUIRED,
          message: 'You need to sign in to use this model.',
        },
      },
      401
    );
  }

  // Free model: allow anonymous access
  // NOTE: promotion-limit.ts (Phase 3) runs next and enforces the anonymous request cap.
  c.set('user', createAnonymousContext(c.get('clientIp')));
  return next();
});
