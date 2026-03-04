import { Chat, emoji, type Message, type Thread } from 'chat';
import { createSlackAdapter, type SlackEvent } from '@chat-adapter/slack';
import { createRedisState } from '@chat-adapter/state-redis';
import { getInstallationByTeamId } from '@/lib/integrations/slack-service';
import type { PlatformIntegration } from '@kilocode/db';

async function getSlackPlatformIntegration(message: Message<SlackEvent>) {
  const teamId = message.raw.team_id ?? message.raw.team;

  if (!teamId) throw new Error('Expected a teamId in message.raw');

  return await getInstallationByTeamId(teamId);
}

async function getPlatformIntegration(thread: Thread, message: Message) {
  const parts = thread.id.split(':');
  const platform = parts[0]; // "slack", "discord", "gchat", "teams", "github"

  switch (platform) {
    case 'slack':
      return await getSlackPlatformIntegration(message as Message<SlackEvent>);
    default:
      throw new Error('PlatformNotSupported');
  }
}

async function processMessage(
  thread: Thread,
  _message: Message,
  _platformIntegration: PlatformIntegration
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
  const platformIntegration = await getPlatformIntegration(thread, message);

  if (!platformIntegration) {
    throw new Error('No Active Platform Integration Found');
  }

  const received = thread.createSentMessageFromMessage(message);
  await received.addReaction(emoji.eyes);

  try {
    await processMessage(thread, message, platformIntegration);
  } catch (error) {
    console.error('[Bot] Unhandled error in message handler:', error);
    await thread.post({ markdown: 'Sorry, something went wrong while processing your message.' });
  } finally {
    await Promise.all([received.removeReaction(emoji.eyes), received.addReaction(emoji.check)]);
  }
});
