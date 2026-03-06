import { Actions, Card, LinkButton, Section, CardText, type Message, type Thread } from 'chat';
import { createLinkToken, type PlatformIdentity } from '@/lib/bot-identity';
import { APP_URL } from '@/lib/constants';
import { isChannelLevelMessage } from '@/lib/bot/helpers';

const LINK_ACCOUNT_PATH = '/api/chat/link-account';

export const LINK_ACCOUNT_ACTION_PREFIX = `link-${APP_URL}${LINK_ACCOUNT_PATH}`;

export type LinkAccountTarget = {
  token: string;
  url: string;
};

function buildLinkAccountUrl(token: string): string {
  const url = new URL(LINK_ACCOUNT_PATH, APP_URL);
  url.searchParams.set('token', token);
  return url.toString();
}

export function createLinkAccountTarget(identity: PlatformIdentity): LinkAccountTarget {
  const token = createLinkToken(identity);
  return {
    token,
    url: buildLinkAccountUrl(token),
  };
}

function linkAccountCard(linkTarget: LinkAccountTarget) {
  return Card({
    title: 'Link your Kilo account',
    children: [
      Section([
        CardText(
          'To use Kilo from this workspace you first need to link your chat account. ' +
            'Click the button below to sign in and link your account. ' +
            'After linking, Kilo will continue with your original message automatically.'
        ),
      ]),
      Actions([LinkButton({ label: 'Link Account', url: linkTarget.url, style: 'primary' })]),
    ],
  });
}

export async function promptLinkAccount(
  thread: Thread,
  message: Message,
  linkTarget: LinkAccountTarget
): Promise<void> {
  // Post to the channel when the @mention is top-level, otherwise into the thread.
  const target = isChannelLevelMessage(thread, message) ? thread.channel : thread;

  await target.postEphemeral(message.author, linkAccountCard(linkTarget), {
    fallbackToDM: true,
  });
}
