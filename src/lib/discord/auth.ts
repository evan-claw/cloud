import 'server-only';
import { generateApiToken } from '@/lib/tokens';
import { findUserById } from '@/lib/user';
import type { Owner } from '@/lib/integrations/core/types';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import { getAuthorizedKiloUserIdForDiscordUser } from '@/lib/discord/authorized-users';

export type DiscordAuthErrorCode =
  | 'missing_requester'
  | 'unlinked_requester'
  | 'not_org_member'
  | 'not_user_owner'
  | 'linked_user_missing';

type DiscordAuthResult =
  | { authToken: string; userId: string }
  | { error: string; errorCode: DiscordAuthErrorCode };

/**
 * Generate an auth token for a Discord requester tied to a Kilo user.
 * We only authorize requesters that are explicitly linked through Discord OAuth.
 */
export async function getDiscordAuthTokenForRequester(
  owner: Owner,
  params: { metadata: unknown; discordUserId?: string | null }
): Promise<DiscordAuthResult> {
  if (!params.discordUserId) {
    return {
      error: 'Could not verify the Discord requester for this message.',
      errorCode: 'missing_requester',
    };
  }

  const linkedKiloUserId = getAuthorizedKiloUserIdForDiscordUser(
    params.metadata,
    params.discordUserId
  );
  if (!linkedKiloUserId) {
    return {
      error:
        'This Discord user is not linked to a Kilo member for this integration. Open Kilo integration settings and click "Link My Discord Account" using this Discord user.',
      errorCode: 'unlinked_requester',
    };
  }

  if (owner.type === 'org') {
    const isMember = await isOrganizationMember(owner.id, linkedKiloUserId);
    if (!isMember) {
      return {
        error: 'This Discord user is not a member of the organization that owns this integration.',
        errorCode: 'not_org_member',
      };
    }
  } else if (linkedKiloUserId !== owner.id) {
    return {
      error: 'Only the owner of this user-level integration can use it.',
      errorCode: 'not_user_owner',
    };
  }

  const user = await findUserById(linkedKiloUserId);
  if (!user) {
    return {
      error: `Linked Kilo user not found for Discord user ${params.discordUserId}. Re-authorize the integration from Kilo.`,
      errorCode: 'linked_user_missing',
    };
  }

  const authToken = generateApiToken(user, { internalApiUse: true });

  return { authToken, userId: user.id };
}
