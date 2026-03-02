import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user.server';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { getDiscordUserLinkOAuthUrl, getInstallation } from '@/lib/integrations/discord-service';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import type { Owner } from '@/lib/integrations/core/types';

const LinkRequestSchema = z.discriminatedUnion('ownerType', [
  z.object({ ownerType: z.literal('org'), ownerId: z.uuid() }),
  z.object({ ownerType: z.literal('user'), ownerId: z.string().min(1) }),
]);

function buildIntegrationPath(owner: Owner, queryParam?: string): string {
  const basePath =
    owner.type === 'org'
      ? `/organizations/${owner.id}/integrations/discord`
      : '/integrations/discord';

  return queryParam ? `${basePath}?${queryParam}` : basePath;
}

function buildSignInPath(callbackPath: string): string {
  return `/users/sign_in?callbackPath=${encodeURIComponent(callbackPath)}`;
}

export async function GET(request: NextRequest) {
  const parsed = LinkRequestSchema.safeParse({
    ownerType: request.nextUrl.searchParams.get('ownerType'),
    ownerId: request.nextUrl.searchParams.get('ownerId'),
  });

  if (!parsed.success) {
    return NextResponse.redirect(new URL('/integrations/discord?error=invalid_link', APP_URL));
  }

  const owner: Owner =
    parsed.data.ownerType === 'org'
      ? { type: 'org', id: parsed.data.ownerId }
      : { type: 'user', id: parsed.data.ownerId };

  const callbackPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const authResult = await getUserFromAuth({ adminOnly: false });
  if (!authResult.user) {
    return NextResponse.redirect(new URL(buildSignInPath(callbackPath), APP_URL));
  }

  if (owner.type === 'org' && !authResult.user.is_admin) {
    const isMember = await isOrganizationMember(owner.id, authResult.user.id);
    if (!isMember) {
      return NextResponse.redirect(
        new URL(buildIntegrationPath(owner, 'error=unauthorized'), APP_URL)
      );
    }
  }

  if (owner.type === 'user' && authResult.user.id !== owner.id) {
    return NextResponse.redirect(
      new URL(buildIntegrationPath(owner, 'error=unauthorized'), APP_URL)
    );
  }

  const installation = await getInstallation(owner);
  if (!installation) {
    return NextResponse.redirect(
      new URL(buildIntegrationPath(owner, 'error=installation_missing'), APP_URL)
    );
  }

  const statePrefix = owner.type === 'org' ? `org_${owner.id}` : `user_${owner.id}`;
  const state = createOAuthState(statePrefix, authResult.user.id);
  return NextResponse.redirect(getDiscordUserLinkOAuthUrl(state));
}
