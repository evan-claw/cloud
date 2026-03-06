import { Chat, type ActionEvent, type Message, type Thread } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createRedisState } from '@chat-adapter/state-redis';
import { createMemoryState } from '@chat-adapter/state-memory';
import { captureException } from '@sentry/nextjs';
import { resolveKiloUserId, type PlatformIdentity, unlinkKiloUser } from '@/lib/bot-identity';
import { handleLinkedBotMessage } from '@/lib/bot/handle-linked-message';
import { getPlatformIdentity, getPlatformIntegration } from '@/lib/bot/platform-helpers';
import {
  createLinkAccountTarget,
  LINK_ACCOUNT_ACTION_PREFIX,
  promptLinkAccount,
} from '@/lib/bot/link-account';
import { storePendingLinkReplay } from '@/lib/bot/pending-link-replay';
import { findUserById } from '@/lib/user';

const slackAdapter = createSlackAdapter({
  clientId: process.env.SLACK_NEXT_CLIENT_ID,
  clientSecret: process.env.SLACK_NEXT_CLIENT_SECRET,
  signingSecret: process.env.SLACK_NEXT_SIGNING_SECRET,
});

export const bot = new Chat({
  // TODO(remon): Update names before going live
  userName: process.env.NODE_ENV === 'production' ? 'Pound' : 'Sjors Bot',
  adapters: {
    slack: slackAdapter,
  },
  state: process.env.REDIS_URL ? createRedisState() : createMemoryState(),
});

async function promptLinkAccountForMessage(
  thread: Thread,
  message: Message,
  identity: PlatformIdentity
): Promise<void> {
  const linkAccountTarget = createLinkAccountTarget(identity);

  try {
    await storePendingLinkReplay(bot.getState(), linkAccountTarget.token, thread, message);
  } catch (error) {
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'store-pending-link-replay' },
      extra: {
        messageId: message.id,
        platform: identity.platform,
        teamId: identity.teamId,
        threadId: thread.id,
        userId: identity.userId,
      },
    });
  }

  await promptLinkAccount(thread, message, linkAccountTarget);
}

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
    captureException(new Error('No active platform integration found'), {
      extra: { platform: identity.platform, teamId: identity.teamId },
    });
    return;
  }

  if (!kiloUserId) {
    await promptLinkAccountForMessage(thread, message, identity);
    return;
  }

  const user = await findUserById(kiloUserId);

  if (!user) {
    await unlinkKiloUser(bot.getState(), identity);
    await promptLinkAccountForMessage(thread, message, identity);
    return;
  }

  await handleLinkedBotMessage({ thread, message, platformIntegration, user });
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
