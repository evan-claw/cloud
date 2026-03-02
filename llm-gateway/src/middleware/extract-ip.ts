import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';

const MAX_HEADER_LENGTH = 500;

function limitLength(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, MAX_HEADER_LENGTH).trim() || null;
}

export const extractIpMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  // CF-Connecting-IP is the authoritative source on Cloudflare Workers
  const cfIp = c.req.header('CF-Connecting-IP');
  const xffIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const clientIp = cfIp ?? xffIp;

  if (!clientIp) {
    return c.json({ error: 'Unable to determine client IP' }, 400);
  }

  c.set('clientIp', clientIp);
  c.set('modeHeader', limitLength(c.req.header('x-kilocode-mode')));

  await next();
});
