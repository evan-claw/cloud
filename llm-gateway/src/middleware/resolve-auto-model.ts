import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';
import { isKiloAutoModel, resolveAutoModel } from '../lib/kilo-auto-model';

export const resolveAutoModelMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const body = c.get('requestBody');
  const resolvedModel = c.get('resolvedModel');

  if (isKiloAutoModel(resolvedModel)) {
    const modeHeader = c.get('modeHeader');
    const resolved = resolveAutoModel(resolvedModel, modeHeader);

    // Save original kilo/auto* id before overwriting
    c.set('autoModel', resolvedModel);

    // Merge resolved fields into request body so downstream sees the real model
    Object.assign(body, resolved);
    c.set('resolvedModel', resolved.model.toLowerCase());
  } else {
    c.set('autoModel', null);
  }

  await next();
});
