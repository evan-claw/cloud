import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, ErrorCode } from '../types';

/**
 * Extract bearer token from Authorization header
 */
export function extractBearerToken(c: Context<{ Bindings: Env }>): string | null {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Verify admin token from environment
 */
export function verifyAdminToken(c: Context<{ Bindings: Env }>): boolean {
  const token = extractBearerToken(c);
  if (!token) {
    return false;
  }

  const adminToken = c.env.DB_PROXY_ADMIN_TOKEN;
  if (!adminToken || adminToken.trim().length === 0) {
    return false;
  }

  return timingSafeEqual(token, adminToken);
}

/**
 * Generate a cryptographically random token (32 bytes, hex-encoded)
 */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify a token against stored token using timing-safe comparison
 */
export function verifyToken(providedToken: string, storedToken: string): boolean {
  return timingSafeEqual(providedToken, storedToken);
}

/**
 * Timing-safe string comparison using crypto.subtle.timingSafeEqual
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  if (aBytes.length !== bBytes.length) {
    crypto.subtle.timingSafeEqual(aBytes, aBytes);
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

/**
 * Create an error response with standard format
 */
export function errorResponse(
  c: Context<{ Bindings: Env }>,
  code: ErrorCode,
  message: string,
  status: ContentfulStatusCode
) {
  return c.json({ error: { code, message } }, status);
}

/**
 * Middleware to require admin authentication
 */
export function requireAdminAuth(c: Context<{ Bindings: Env }>): Response | null {
  if (!verifyAdminToken(c)) {
    return errorResponse(c, 'UNAUTHORIZED', 'Invalid or missing admin token', 401) as Response;
  }
  return null;
}
