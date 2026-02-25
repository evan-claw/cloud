import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import { generateApiToken } from '@/lib/tokens';
import { findUserById } from '@/lib/user';
import type { Owner } from '@/lib/integrations/core/types';
import { getOrganizationMemberByEmail } from '@/lib/organizations/organizations';

/**
 * Generate an auth token for the given owner (user or organization)
 */
export async function getSlackbotAuthTokenForOwner(
  owner: Owner,
  slackUserEmail?: string
): Promise<{ authToken: string; error?: undefined } | { authToken?: undefined; error: string }> {
  let authToken: string | undefined;
  if (owner.type === 'org') {
    const memberInfo =
      slackUserEmail && (await getOrganizationMemberByEmail(owner.id, slackUserEmail));

    console.log(`[SlackBot] ${slackUserEmail} is ${memberInfo ? 'a member' : 'not a member'}`);

    if (memberInfo) {
      authToken = generateApiToken(memberInfo.kilocode_users, { internalApiUse: true });
    } else {
      const user = await ensureBotUserForOrg(owner.id, 'slack-bot');
      authToken = generateApiToken(user, { botId: 'slack-bot', internalApiUse: true });
    }
  } else {
    const user = await findUserById(owner.id);

    if (user) {
      authToken = generateApiToken(user, { internalApiUse: true });
    }
  }

  if (!authToken) {
    throw new Error(`Slackbot User not found for ID: ${owner.id} and type: ${owner.type}`);
  }

  return { authToken };
}
