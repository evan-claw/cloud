import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { chat } from '@/lib/chat-bot';

/**
 * Slack Events API webhook handler.
 *
 * Delegates all event handling to the Chat SDK which handles:
 * - Signature verification
 * - URL verification challenge
 * - Event routing (app_mention, message, reactions, etc.)
 * - Bot self-message filtering
 * - Deduplication
 *
 * The actual bot logic is registered via event handlers in @/lib/chat-bot.
 */
export async function POST(request: NextRequest) {
  console.log('[SlackBot:Webhook] POST request received');

  return chat.webhooks.slack(request, {
    waitUntil: p => after(() => p),
  });
}
