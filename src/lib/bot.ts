import {
  Actions,
  Card,
  Chat,
  emoji,
  LinkButton,
  Section,
  CardText,
  type ActionEvent,
  type Message,
  type Thread,
} from 'chat';
import { createSlackAdapter, type SlackEvent } from '@chat-adapter/slack';
import { createRedisState } from '@chat-adapter/state-redis';
import { getInstallationByTeamId } from '@/lib/integrations/slack-service';
import { createLinkToken, resolveKiloUserId, type PlatformIdentity } from '@/lib/bot-identity';
import { APP_URL } from '@/lib/constants';
import type { PlatformIntegration } from '@kilocode/db';

// -- Platform helpers ---------------------------------------------------------

function getSlackTeamId(message: Message<SlackEvent>): string {
  const teamId = message.raw.team_id ?? message.raw.team;
  if (!teamId) throw new Error('Expected a teamId in message.raw');
  return teamId;
}

/**
 * Extract platform identity coordinates from any adapter's message.
 * Extend the switch for Discord / Teams / Google Chat / etc.
 */
function getPlatformIdentity(thread: Thread, message: Message): PlatformIdentity {
  const platform = thread.id.split(':')[0]; // "slack", "discord", "gchat", "teams", …

  switch (platform) {
    case 'slack': {
      const teamId = getSlackTeamId(message as Message<SlackEvent>);
      return { platform: 'slack', teamId, userId: message.author.userId };
    }
    default:
      throw new Error(`PlatformNotSupported: ${platform}`);
  }
}

async function getPlatformIntegration(thread: Thread, message: Message) {
  const platform = thread.id.split(':')[0];

  switch (platform) {
    case 'slack':
      return await getInstallationByTeamId(getSlackTeamId(message as Message<SlackEvent>));
    default:
      throw new Error(`PlatformNotSupported: ${platform}`);
  }
}

// -- Link-account prompt ------------------------------------------------------

const LINK_ACCOUNT_PATH = '/api/chat/link-account';

/** Prefix that the Slack adapter auto-generates for LinkButton action_ids. */
const LINK_ACCOUNT_ACTION_PREFIX = `link-${APP_URL}${LINK_ACCOUNT_PATH}`;

function buildLinkAccountUrl(identity: PlatformIdentity): string {
  const url = new URL(LINK_ACCOUNT_PATH, APP_URL);
  url.searchParams.set('token', createLinkToken(identity));
  return url.toString();
}

function linkAccountCard(linkUrl: string) {
  return Card({
    title: 'Link your Kilo account',
    children: [
      Section([
        CardText(
          'To use Kilo from this workspace you first need to link your chat account. ' +
            'Click the button below to sign in and link your account.'
        ),
      ]),
      Actions([LinkButton({ label: 'Link Account', url: linkUrl, style: 'primary' })]),
    ],
  });
}

async function promptLinkAccount(
  thread: Thread,
  message: Message,
  identity: PlatformIdentity
): Promise<void> {
  const linkUrl = buildLinkAccountUrl(identity);

  await thread.postEphemeral(message.author, linkAccountCard(linkUrl), {
    fallbackToDM: true,
  });
}

// -- Message processing -------------------------------------------------------

async function processMessage(
  thread: Thread,
  _message: Message,
  _platformIntegration: PlatformIntegration,
  _kiloUserId: string
) {
  await thread.post('TODO');
}

// -- Bot instance -------------------------------------------------------------

const slackAdapter = createSlackAdapter({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
});

export const bot = new Chat({
  userName: process.env.NODE_ENV === 'production' ? 'Kilo' : 'Henk Bot',
  adapters: {
    slack: slackAdapter,
  },
  state: createRedisState(),
});

bot.onNewMention(async function handleIncomingMessage(
  thread: Thread,
  message: Message
): Promise<void> {
  const identity = getPlatformIdentity(thread, message);
  const [platformIntegration, kiloUserId] = await Promise.all([
    getPlatformIntegration(thread, message),
    resolveKiloUserId(bot.getState(), identity),
  ]);

  if (!platformIntegration) {
    throw new Error('No Active Platform Integration Found');
  }

  if (!kiloUserId) {
    await promptLinkAccount(thread, message, identity);
    return;
  }

  const received = thread.createSentMessageFromMessage(message);
  await received.addReaction(emoji.eyes);

  try {
    await processMessage(thread, message, platformIntegration, kiloUserId);
  } catch (error) {
    console.error('[Bot] Unhandled error in message handler:', error);
    await thread.post({ markdown: 'Sorry, something went wrong while processing your message.' });
  } finally {
    await Promise.all([received.removeReaction(emoji.eyes), received.addReaction(emoji.check)]);
  }
});

// When the user clicks the "Link Account" LinkButton, Slack fires a
// block_actions event *in addition to* opening the URL in the browser.
// For ephemeral messages the adapter encodes the response_url into the
// messageId, so deleteMessage sends `{ delete_original: true }` — removing
// the ephemeral card from the user's view.
bot.onAction(async function handleLinkAccountClick(event: ActionEvent): Promise<void> {
  if (!event.actionId.startsWith(LINK_ACCOUNT_ACTION_PREFIX)) return;

  try {
    await event.adapter.deleteMessage(event.threadId, event.messageId);
  } catch (error) {
    // Not critical — the ephemeral message will disappear on its own eventually
    console.warn('[Bot] Failed to delete link-account ephemeral:', error);
  }
});
