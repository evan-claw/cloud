import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { DISCORD_BOT_TOKEN } from '@/lib/config.server';
import { CRON_SECRET } from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';
import { db, sql } from '@/lib/drizzle';
import { discord_gateway_listener } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const maxDuration = 800;

/**
 * Maximum duration for the Gateway listener (in ms).
 * On Vercel, this should be less than the function's maxDuration.
 * The cron job should run more frequently than this duration to ensure overlap.
 */
const GATEWAY_DURATION_MS = 600 * 1000; // 10 minutes

/**
 * How often the listener checks if it's been superseded (in ms).
 * Lower = faster handoff, but more DB queries.
 */
const HEARTBEAT_INTERVAL_MS = 10_000; // 10 seconds

/**
 * Discord Gateway listener with Postgres-based coordination.
 *
 * Architecture:
 * - This route is triggered by a cron job (e.g., every 3 minutes)
 * - It connects to Discord's Gateway via WebSocket using discord.js
 * - When it receives MESSAGE_CREATE events, it forwards them as HTTP POST
 *   requests to the webhook handler (/discord/webhook) for unified processing
 * - The listener runs for GATEWAY_DURATION_MS, then cleanly disconnects
 *
 * Coordination:
 * - On startup, the listener atomically claims the "active listener" slot in Postgres
 * - While running, it periodically checks if it's still the active listener
 * - If a new listener has taken over, it aborts and disconnects cleanly
 * - This ensures only one Gateway connection is active at a time, preventing
 *   duplicate message processing from overlapping cron invocations
 */
export async function GET(request: NextRequest) {
  // Verify cron secret to prevent unauthorized invocations
  const authHeader = request.headers.get('authorization');

  if (!CRON_SECRET) {
    return new NextResponse('CRON_SECRET not configured', { status: 500 });
  }

  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  if (!DISCORD_BOT_TOKEN) {
    return NextResponse.json({ error: 'DISCORD_BOT_TOKEN is not configured' }, { status: 500 });
  }

  const webhookUrl = `${APP_URL}/discord/webhook`;
  const listenerId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  console.log('[DiscordGateway] Starting Gateway listener', { listenerId, webhookUrl });

  try {
    // Atomically claim the active listener slot
    const expiresAt = new Date(Date.now() + GATEWAY_DURATION_MS).toISOString();
    await claimActiveListener(listenerId, expiresAt);

    const abortController = new AbortController();

    // Start heartbeat polling in the background
    const heartbeatPromise = runHeartbeat(listenerId, abortController);

    // Run the Gateway listener (will resolve when duration elapses or aborted)
    await runGatewayListener(webhookUrl, GATEWAY_DURATION_MS, abortController.signal);

    // Stop heartbeat
    abortController.abort();
    await heartbeatPromise;

    return NextResponse.json({ status: 'completed', listenerId });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[DiscordGateway] Gateway listener error:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * Atomically claim the active listener slot using INSERT ... ON CONFLICT UPDATE.
 * This upserts the singleton row (id=1), replacing whatever listener was there before.
 */
async function claimActiveListener(listenerId: string, expiresAt: string): Promise<void> {
  await db
    .insert(discord_gateway_listener)
    .values({
      id: 1,
      listener_id: listenerId,
      started_at: new Date().toISOString(),
      expires_at: expiresAt,
    })
    .onConflictDoUpdate({
      target: discord_gateway_listener.id,
      set: {
        listener_id: listenerId,
        started_at: sql`now()`,
        expires_at: expiresAt,
      },
    });

  console.log('[DiscordGateway] Claimed active listener slot', { listenerId });
}

/**
 * Periodically check if this listener is still the active one.
 * If a newer listener has taken over, trigger the abort signal.
 */
async function runHeartbeat(listenerId: string, abortController: AbortController): Promise<void> {
  while (!abortController.signal.aborted) {
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        abortController.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, HEARTBEAT_INTERVAL_MS);
      abortController.signal.addEventListener('abort', done, { once: true });
    });

    if (abortController.signal.aborted) break;

    try {
      const rows = await db
        .select({ listener_id: discord_gateway_listener.listener_id })
        .from(discord_gateway_listener)
        .where(eq(discord_gateway_listener.id, 1))
        .limit(1);

      const currentListenerId = rows[0]?.listener_id;

      if (currentListenerId && currentListenerId !== listenerId) {
        console.log('[DiscordGateway] Superseded by new listener, shutting down', {
          myId: listenerId,
          newId: currentListenerId,
        });
        abortController.abort();
        break;
      }
    } catch (error) {
      // Log but don't crash on heartbeat failures — a missed heartbeat is not fatal,
      // it just means we might overlap briefly until the next check
      console.error('[DiscordGateway] Heartbeat check failed:', error);
    }
  }
}

/**
 * Run the Discord Gateway listener for a specified duration.
 * Connects via discord.js, listens for raw events, and forwards
 * MESSAGE_CREATE events to the webhook URL.
 *
 * Respects the abort signal for clean shutdown when superseded.
 */
async function runGatewayListener(
  webhookUrl: string,
  durationMs: number,
  abortSignal: AbortSignal
): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });

  let isShuttingDown = false;
  let botUserId: string | null = null;

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      void client.destroy();
      resolve();
    };

    // Duration timeout
    const timeout = setTimeout(() => {
      console.log('[DiscordGateway] Duration reached, disconnecting');
      cleanup();
    }, durationMs);

    // Abort signal (from heartbeat detecting supersession)
    if (abortSignal.aborted) {
      clearTimeout(timeout);
      cleanup();
      return;
    }
    abortSignal.addEventListener(
      'abort',
      () => {
        console.log('[DiscordGateway] Abort signal received, disconnecting');
        clearTimeout(timeout);
        cleanup();
      },
      { once: true }
    );

    client.once(Events.ClientReady, readyClient => {
      console.log(`[DiscordGateway] Connected as ${readyClient.user.tag}`);
      botUserId = readyClient.user.id;
    });

    client.on(Events.Error, error => {
      console.error('[DiscordGateway] Client error:', error.message);
    });

    // Listen to raw events and forward MESSAGE_CREATE to the webhook
    client.on('raw', async (packet: { t: string; d: unknown }) => {
      if (isShuttingDown) return;

      if (packet.t === 'MESSAGE_CREATE') {
        const forwardedEvent = {
          type: `GATEWAY_${packet.t}`,
          timestamp: Date.now(),
          data: packet.d,
          botUserId,
        };

        try {
          const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-discord-gateway-token': DISCORD_BOT_TOKEN,
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

    client.login(DISCORD_BOT_TOKEN).catch(error => {
      clearTimeout(timeout);
      reject(error as Error);
    });
  });
}
