import 'server-only';
import { Chat, ConsoleLogger, emoji, type Thread, type Message } from 'chat';
import { createSlackAdapter, type SlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET } from '@/lib/config.server';
import {
  getInstallationByTeamId,
  getOwnerFromInstallation,
  getAccessTokenFromInstallation,
} from '@/lib/integrations/slack-service';
import { processKiloBotMessage } from '@/lib/slack-bot';
import { logSlackBotRequest } from '@/lib/slack-bot-logging';
import { getSlackBotUserIdFromInstallation } from '@/lib/slack-bot/slack-utils';
import { getDevUserSuffix } from '@/lib/slack-bot/dev-user-info';
import { APP_URL } from '@/lib/constants';
import { db } from '@/lib/drizzle';
import { cliSessions } from '@/db/schema';
import { eq } from 'drizzle-orm';

import type { Owner } from '@/lib/integrations/core/types';
import type { PlatformIntegration } from '@/db/schema';
import type { SlackEventContext } from '@/lib/slack-bot/slack-channel-context';
import type { SlackBotEventType } from '@/db/schema';

/**
 * Create the Slack adapter for the Chat SDK.
 *
 * We operate in multi-workspace mode (no default botToken).
 * The adapter resolves tokens per-team using setInstallation/getInstallation
 * backed by the state adapter. We bridge from our DB on each webhook request
 * via the `syncInstallationToState` helper.
 */
const logger = new ConsoleLogger('info', 'ChatBot');

const slackAdapter = createSlackAdapter({
  signingSecret: SLACK_SIGNING_SECRET ?? '',
  logger,
  clientId: SLACK_CLIENT_ID ?? undefined,
  clientSecret: SLACK_CLIENT_SECRET ?? undefined,
});

/**
 * The Chat SDK instance -- singleton for the application.
 *
 * Uses in-memory state for now. For production with multiple server instances,
 * swap to createRedisState({ url: process.env.REDIS_URL!, logger: 'info' }).
 */
const chat = new Chat({
  userName: 'kilo',
  adapters: {
    slack: slackAdapter,
  },
  state: createMemoryState(),
  logger: 'info',
});

// Register as singleton for thread/message deserialization support
chat.registerSingleton();

// ---------------------------------------------------------------------------
// Installation bridge: sync our DB installations into the Chat SDK state
// ---------------------------------------------------------------------------

/**
 * Ensure the Chat SDK's Slack adapter has the installation for a given team.
 * Called before webhook handling to bridge our DB-stored installations
 * into the adapter's state-backed installation cache.
 */
export async function syncInstallationToState(teamId: string): Promise<PlatformIntegration | null> {
  const installation = await getInstallationByTeamId(teamId);
  if (!installation) return null;

  const accessToken = getAccessTokenFromInstallation(installation);
  if (!accessToken) return null;

  const botUserId = getSlackBotUserIdFromInstallation(installation);

  await slackAdapter.setInstallation(teamId, {
    botToken: accessToken,
    botUserId: botUserId ?? undefined,
    teamName: installation.platform_account_login ?? undefined,
  });

  return installation;
}

// ---------------------------------------------------------------------------
// Session URL helpers (moved from webhook route)
// ---------------------------------------------------------------------------

function buildSessionUrl(dbSessionId: string, owner: Owner): string {
  const basePath = owner.type === 'org' ? `/organizations/${owner.id}/cloud` : '/cloud';
  return `${APP_URL}${basePath}/chat?sessionId=${dbSessionId}`;
}

async function getDbSessionIdFromCloudAgentId(cloudAgentSessionId: string): Promise<string | null> {
  const [session] = await db
    .select({ session_id: cliSessions.session_id })
    .from(cliSessions)
    .where(eq(cliSessions.cloud_agent_session_id, cloudAgentSessionId))
    .limit(1);

  return session?.session_id ?? null;
}

// ---------------------------------------------------------------------------
// Extract Slack-specific context from a Chat SDK message
// ---------------------------------------------------------------------------

/**
 * Extract Slack event context from a Chat SDK thread + message.
 * Maps from the Chat SDK's normalized format back to the Slack-specific
 * context our processKiloBotMessage expects.
 */
function extractSlackEventContext(
  thread: Thread,
  message: Message
): { teamId: string; slackEventContext: SlackEventContext } | null {
  // Thread ID format: "slack:CHANNEL:THREAD_TS"
  const slackAdapter = chat.getAdapter('slack');
  const decoded = slackAdapter.decodeThreadId(thread.id);

  // The team_id comes from the raw Slack event
  const raw = message.raw as { team?: string; team_id?: string };
  const teamId = raw.team_id ?? raw.team;
  if (!teamId) return null;

  return {
    teamId,
    slackEventContext: {
      channelId: decoded.channel,
      threadTs: decoded.threadTs,
      userId: message.author.userId,
      messageTs: message.id, // Slack message ts is the message ID
    },
  };
}

// ---------------------------------------------------------------------------
// Core message handler -- shared between onNewMention and onSubscribedMessage
// ---------------------------------------------------------------------------

async function handleBotMessage(thread: Thread, message: Message): Promise<void> {
  const context = extractSlackEventContext(thread, message);
  if (!context) {
    console.error('[ChatBot] Could not extract Slack context from message');
    return;
  }

  const { teamId, slackEventContext } = context;
  const startTime = Date.now();

  // Sync installation to state (ensures adapter has the token)
  const installation = await syncInstallationToState(teamId);
  if (!installation) {
    console.error('[ChatBot] No installation found for team:', teamId);
    await thread.post(
      'Error: No Slack integration found for this workspace. Please install the Kilo Code Slack integration.'
    );
    return;
  }

  // Add processing reaction to the original message
  // We need the SentMessage wrapper to use addReaction
  const originalMessage = thread.createSentMessageFromMessage(message);
  await originalMessage.addReaction(emoji.hourglass);

  // The Chat SDK already strips the bot @mention and normalizes the text
  const userText = message.text;
  if (!userText.trim()) {
    console.log('[ChatBot] Empty message text, ignoring');
    await originalMessage.removeReaction(emoji.hourglass);
    return;
  }

  console.log('[ChatBot] Processing message:', userText.slice(0, 100));

  // Process through the existing AI brain
  const result = await processKiloBotMessage(userText, teamId, slackEventContext);
  const responseTimeMs = Date.now() - startTime;

  // Append dev user suffix if in dev environment
  const responseWithDevInfo = result.response + getDevUserSuffix();

  // Post the response -- the Chat SDK handles markdown -> mrkdwn conversion
  await thread.post({ markdown: responseWithDevInfo });

  // Swap reactions: remove hourglass, add checkmark
  await Promise.all([
    originalMessage.removeReaction(emoji.hourglass),
    originalMessage.addReaction(emoji.check),
  ]);

  // Post ephemeral session link if a Cloud Agent session was created
  if (result.cloudAgentSessionId && message.author.userId) {
    const owner = getOwnerFromInstallation(installation);
    if (owner) {
      const dbSessionId = await getDbSessionIdFromCloudAgentId(result.cloudAgentSessionId);
      if (dbSessionId) {
        const sessionUrl = buildSessionUrl(dbSessionId, owner);
        // Use the Chat SDK's ephemeral support with a card containing a link button
        await thread.postEphemeral(
          message.author,
          { markdown: `[View Session](${sessionUrl})` },
          { fallbackToDM: true }
        );
      }
    }
  }

  // Determine event type for logging
  const eventType: SlackBotEventType = message.isMention ? 'app_mention' : 'message';

  // Log the request
  await logSlackBotRequest({
    slackTeamId: teamId,
    slackTeamName: installation?.platform_account_login ?? undefined,
    slackChannelId: slackEventContext.channelId,
    slackUserId: message.author.userId ?? 'unknown',
    slackThreadTs: slackEventContext.threadTs,
    eventType,
    userMessage: userText,
    status: result.error ? 'error' : 'success',
    errorMessage: result.error,
    responseTimeMs,
    modelUsed: result.modelUsed,
    toolCallsMade: result.toolCallsMade.length > 0 ? result.toolCallsMade : undefined,
    cloudAgentSessionId: result.cloudAgentSessionId,
    integration: installation,
  });

  console.log('[ChatBot] Message processing completed');
}

// ---------------------------------------------------------------------------
// Register event handlers
// ---------------------------------------------------------------------------

/**
 * Handle new @mentions in unsubscribed threads.
 * Subscribe to the thread so follow-up messages are also handled.
 */
chat.onNewMention(async (thread, message) => {
  console.log('[ChatBot] New mention received');
  await thread.subscribe();
  await handleBotMessage(thread, message);
});

/**
 * Handle messages in subscribed threads.
 * This fires for follow-up messages after the initial @mention.
 */
chat.onSubscribedMessage(async (thread, message) => {
  console.log('[ChatBot] Subscribed message received, isMention:', message.isMention);
  // Process all messages in subscribed threads (not just mentions)
  // This enables conversational follow-ups
  await handleBotMessage(thread, message);
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { chat, slackAdapter };
export type { SlackAdapter };
