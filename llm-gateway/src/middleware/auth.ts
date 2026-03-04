import { createMiddleware } from 'hono/factory';
import { and, eq } from 'drizzle-orm';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import type { HonoContext } from '../types/hono';
import { extractBearerToken } from '@kilocode/worker-utils';
import { verifyGatewayJwt, isPepperValid } from '../lib/jwt';

const ORGANIZATION_ID_HEADER = 'x-kilocode-organizationid';

// Port of isEmailBlacklistedByDomain from src/lib/user.server.ts.
// BLACKLIST_DOMAINS is a pipe-separated string (e.g. "domain1.com|domain2.com").
function isEmailBlacklistedByDomain(
  email: string,
  blacklistDomainsRaw: string | undefined
): boolean {
  if (!blacklistDomainsRaw) return false;
  const domains = blacklistDomainsRaw.split('|').map(d => d.trim().toLowerCase());
  const emailLower = email.toLowerCase();
  return domains.some(
    domain => emailLower.endsWith('@' + domain) || emailLower.endsWith('.' + domain)
  );
}

export const authMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization'));

  if (!token) {
    // No token — let anonymous-gate decide
    return next();
  }

  const secret = await c.env.NEXTAUTH_SECRET_PROD.get();
  const verifyResult = await verifyGatewayJwt(token, secret);

  if (!verifyResult.ok) {
    console.warn('AUTH-FAIL 401: Invalid or expired token');
    return next();
  }

  const { payload } = verifyResult;
  const db = c.get('db');

  const rows = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, payload.kiloUserId))
    .limit(1);
  const user = rows[0];

  if (!user) {
    console.warn(`AUTH-FAIL 401 (${payload.kiloUserId}): User not found`);
    return next();
  }

  if (!isPepperValid(payload.apiTokenPepper, user.api_token_pepper)) {
    console.warn(`AUTH-FAIL 401 (${user.id}): Token has been revoked`);
    return next();
  }

  // Blocked user — treat as unauthenticated (matches reference validateUserAuthorization)
  if (user.blocked_reason) {
    console.warn(`AUTH-FAIL 403 (${user.id}): Access denied (R1)`);
    return next();
  }

  // Blacklisted email domain — treat as unauthenticated
  const blacklistDomains = await c.env.BLACKLIST_DOMAINS.get();
  if (isEmailBlacklistedByDomain(user.google_user_email, blacklistDomains ?? undefined)) {
    console.warn(`AUTH-FAIL 403 (${user.id}): Access denied (R0)`);
    return next();
  }

  // Validate org membership when an org ID header is present.
  // The reference validates this in getUserFromAuth → validateUserAuthorization.
  // If the user is not a member, treat as unauthenticated (prevents BYOK key leakage
  // and unauthorized org balance usage).
  const organizationId = c.req.header(ORGANIZATION_ID_HEADER) ?? undefined;
  if (organizationId) {
    const [membership] = await db
      .select({ id: organization_memberships.id })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(organization_memberships.kilo_user_id, user.id)
        )
      )
      .limit(1);
    if (!membership) {
      console.warn(`AUTH-FAIL 403 (${user.id}): Access denied (not a member of the organization)`);
      return next();
    }
  }

  c.set('authUser', user);
  c.set('organizationId', organizationId);
  c.set('botId', payload.botId);
  c.set('tokenSource', payload.tokenSource);

  return next();
});
