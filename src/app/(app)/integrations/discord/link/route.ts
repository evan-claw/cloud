import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user.server';
import { createOAuthState, type OAuthStateContext } from '@/lib/integrations/oauth-state';
import { getDiscordUserLinkOAuthUrl, getInstallation } from '@/lib/integrations/discord-service';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import type { Owner } from '@/lib/integrations/core/types';

const DISCORD_SNOWFLAKE_REGEX = /^\d+$/;

const LinkRequestSchema = z
  .discriminatedUnion('ownerType', [
    z.object({
      ownerType: z.literal('org'),
      ownerId: z.uuid(),
      guildId: z.string().regex(DISCORD_SNOWFLAKE_REGEX).optional(),
      channelId: z.string().regex(DISCORD_SNOWFLAKE_REGEX).optional(),
      messageId: z.string().regex(DISCORD_SNOWFLAKE_REGEX).optional(),
    }),
    z.object({
      ownerType: z.literal('user'),
      ownerId: z.string().min(1),
      guildId: z.string().regex(DISCORD_SNOWFLAKE_REGEX).optional(),
      channelId: z.string().regex(DISCORD_SNOWFLAKE_REGEX).optional(),
      messageId: z.string().regex(DISCORD_SNOWFLAKE_REGEX).optional(),
    }),
  ])
  .superRefine((value, ctx) => {
    const presentCount = [value.guildId, value.channelId, value.messageId].filter(Boolean).length;
    if (presentCount > 0 && presentCount < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'guildId, channelId, and messageId must be provided together',
      });
    }
  });

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
    guildId: request.nextUrl.searchParams.get('guildId') ?? undefined,
    channelId: request.nextUrl.searchParams.get('channelId') ?? undefined,
    messageId: request.nextUrl.searchParams.get('messageId') ?? undefined,
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

  const replayContext: OAuthStateContext | undefined =
    parsed.data.guildId && parsed.data.channelId && parsed.data.messageId
      ? {
          discordReplayGuildId: parsed.data.guildId,
          discordReplayChannelId: parsed.data.channelId,
          discordReplayMessageId: parsed.data.messageId,
        }
      : undefined;

  if (
    replayContext?.discordReplayGuildId &&
    installation.platform_installation_id !== replayContext.discordReplayGuildId
  ) {
    return NextResponse.redirect(
      new URL(buildIntegrationPath(owner, 'error=invalid_link'), APP_URL)
    );
  }

  const statePrefix = owner.type === 'org' ? `org_${owner.id}` : `user_${owner.id}`;
  const state = createOAuthState(statePrefix, authResult.user.id, replayContext);
  return NextResponse.redirect(getDiscordUserLinkOAuthUrl(state));
}
