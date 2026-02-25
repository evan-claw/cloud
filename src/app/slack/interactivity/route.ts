import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { chat } from '@/lib/chat-bot';

/**
 * Slack Interactivity endpoint handler.
 *
 * Handles interactive components like buttons, modals, shortcuts, etc.
 * Delegates to the Chat SDK which handles signature verification and routing.
 *
 * Register handlers via chat.onAction(), chat.onModalSubmit(), etc. in @/lib/chat-bot.
 *
 * @see https://api.slack.com/interactivity/handling
 */
export async function POST(request: NextRequest) {
  console.log('[Slack:Interactivity] POST request received');

  return chat.webhooks.slack(request, {
    waitUntil: p => after(() => p),
  });
}
