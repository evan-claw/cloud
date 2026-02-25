import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { DISCORD_BOT_TOKEN } from '@/lib/config.server';
import { CRON_SECRET } from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';

/**
 * Maximum duration for the Gateway listener (in ms).
 * On Vercel, this should be less than the function's maxDuration.
 * The cron job should run more frequently than this duration to ensure overlap.
 */
const GATEWAY_DURATION_MS = 4 * 60 * 1000; // 4 minutes

/**
 * Discord Gateway listener.
 *
 * Architecture (following the Vercel chat pattern):
 * - This route is triggered by a cron job (e.g., every 3 minutes)
 * - It connects to Discord's Gateway via WebSocket using discord.js
 * - When it receives MESSAGE_CREATE events, it forwards them as HTTP POST
 *   requests to the webhook handler (/discord/webhook) for unified processing
 * - The listener runs for GATEWAY_DURATION_MS, then cleanly disconnects
 *
 * This forwarding pattern means all message processing happens in the webhook
 * handler, regardless of whether events come from HTTP Interactions or the Gateway.
 *
 * Why we need Gateway:
 * Discord's HTTP Interactions API only receives slash commands and component interactions.
 * To receive regular chat messages (e.g., @bot mentions), we need a Gateway connection.
 */
export async function GET(request: NextRequest) {
  // Verify cron secret to prevent unauthorized invocations
  const authHeader = request.headers.get('authorization');
  const cronSecret = request.nextUrl.searchParams.get('cron_secret');

  if (CRON_SECRET) {
    if (authHeader !== `Bearer ${CRON_SECRET}` && cronSecret !== CRON_SECRET) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  if (!DISCORD_BOT_TOKEN) {
    return NextResponse.json({ error: 'DISCORD_BOT_TOKEN is not configured' }, { status: 500 });
  }

  const webhookUrl = `${APP_URL}/discord/webhook`;

  console.log('[DiscordGateway] Starting Gateway listener, forwarding to', webhookUrl);

  try {
    await runGatewayListener(webhookUrl, GATEWAY_DURATION_MS);
    return NextResponse.json({ status: 'completed' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[DiscordGateway] Gateway listener error:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * Run the Discord Gateway listener for a specified duration.
 * Connects via discord.js, listens for raw events, and forwards
 * MESSAGE_CREATE events to the webhook URL.
 */
async function runGatewayListener(webhookUrl: string, durationMs: number): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.log('[DiscordGateway] Duration reached, disconnecting');
      client.destroy();
      resolve();
    }, durationMs);

    client.once(Events.ClientReady, readyClient => {
      console.log(`[DiscordGateway] Connected as ${readyClient.user.tag}`);
    });

    client.on(Events.Error, error => {
      console.error('[DiscordGateway] Client error:', error.message);
    });

    // Listen to raw events and forward MESSAGE_CREATE to the webhook
    client.on('raw', async (packet: { t: string; d: unknown }) => {
      if (packet.t === 'MESSAGE_CREATE') {
        const forwardedEvent = {
          type: `GATEWAY_${packet.t}`,
          timestamp: Date.now(),
          data: packet.d,
        };

        try {
          const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-discord-gateway-token': DISCORD_BOT_TOKEN!,
            },
            body: JSON.stringify(forwardedEvent),
          });

          if (!response.ok) {
            console.error(
              '[DiscordGateway] Failed to forward event:',
              response.status,
              await response.text()
            );
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('[DiscordGateway] Error forwarding event:', errorMessage);
        }
      }
    });

    client.login(DISCORD_BOT_TOKEN!).catch(error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
