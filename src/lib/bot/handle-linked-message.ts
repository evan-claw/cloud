import { emoji, type Message, type Thread } from 'chat';
import type { PlatformIntegration, User } from '@kilocode/db';
import { captureException } from '@sentry/nextjs';
import { getPlatformIntegration } from '@/lib/bot/platform-helpers';
import { createBotRequest, updateBotRequest } from '@/lib/bot/request-logging';
import { processMessage } from '@/lib/bot/run';

type LinkedBotMessageContext = {
  message: Message;
  platformIntegration: PlatformIntegration;
  thread: Thread;
  user: User;
};

export async function handleLinkedBotMessage({
  thread,
  message,
  platformIntegration,
  user,
}: LinkedBotMessageContext): Promise<void> {
  const platform = thread.id.split(':')[0];
  const botRequestId = await createBotRequest({
    createdBy: user.id,
    organizationId: platformIntegration.owned_by_organization_id ?? null,
    platformIntegrationId: platformIntegration.id,
    platform,
    platformThreadId: thread.id,
    platformMessageId: message.id,
    userMessage: message.text,
    modelUsed: undefined,
  });

  const received = thread.createSentMessageFromMessage(message);
  await received.addReaction(emoji.eyes);

  try {
    await processMessage({ thread, message, platformIntegration, user, botRequestId });
  } catch (error) {
    console.error('[Bot] Unhandled error in message handler:', error);
    if (botRequestId) {
      const errMsg = error instanceof Error ? error.message : String(error);
      updateBotRequest(botRequestId, {
        status: 'error',
        errorMessage: errMsg.slice(0, 2000),
      });
    }
    await thread.post({ markdown: 'Sorry, something went wrong while processing your message.' });
  } finally {
    await Promise.all([received.removeReaction(emoji.eyes), received.addReaction(emoji.check)]);
  }
}

export async function replayLinkedBotMessage({
  thread,
  message,
  user,
}: {
  thread: Thread;
  message: Message;
  user: User;
}): Promise<void> {
  const platformIntegration = await getPlatformIntegration(thread, message);

  if (!platformIntegration) {
    captureException(new Error('No active platform integration found during link replay'), {
      extra: {
        messageId: message.id,
        platform: thread.id.split(':')[0],
        threadId: thread.id,
        userId: user.id,
      },
    });
    return;
  }

  await handleLinkedBotMessage({ thread, message, platformIntegration, user });
}
