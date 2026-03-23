/**
 * Lightweight Stream Chat server-side client for Cloudflare Workers.
 *
 * Uses fetch + jose for token generation. Does NOT depend on the `stream-chat`
 * npm package which requires Node.js APIs incompatible with CF Workers.
 *
 * Stream Chat REST API base: https://chat.stream-io-api.com
 * Auth: api_key query param + Authorization: <server_jwt> header
 */
import { SignJWT } from 'jose';

const STREAM_CHAT_API_BASE = 'https://chat.stream-io-api.com';

/**
 * Result of provisioning a Stream Chat default channel for a new KiloClaw instance.
 */
export type StreamChatSetup = {
  apiKey: string;
  /** Bot user ID: `bot-{sandboxId}` */
  botUserId: string;
  /** Permanent JWT for the bot user (used by the openclaw-channel-streamchat plugin) */
  botUserToken: string;
  /** Default channel ID: `default-{sandboxId}` */
  channelId: string;
  /** Permanent JWT for the human user (for future client-side use) */
  userToken: string;
};

/**
 * Generate a Stream Chat server-side JWT.
 * Used for admin operations (creating users, channels) from the CF Worker.
 * Payload: `{ server: true }` — gives full API access.
 */
export async function createServerToken(apiSecret: string): Promise<string> {
  const secretBytes = new TextEncoder().encode(apiSecret);
  return new SignJWT({ server: true })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(secretBytes);
}

/**
 * Generate a Stream Chat user JWT for client-side or bot authentication.
 * Payload: `{ user_id: userId }` — scoped to a single user.
 * No expiry (permanent) for bot tokens; expiry can be added later for human user tokens.
 */
export async function createUserToken(apiSecret: string, userId: string): Promise<string> {
  const secretBytes = new TextEncoder().encode(apiSecret);
  return new SignJWT({ user_id: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(secretBytes);
}

/**
 * Upsert one or more Stream Chat users via the server API.
 * Creates the user if it doesn't exist; updates fields if it does.
 */
export async function upsertStreamChatUsers(
  apiKey: string,
  serverToken: string,
  users: ReadonlyArray<{ id: string; name: string; role?: string }>
): Promise<void> {
  const usersMap: Record<string, { id: string; name: string; role?: string }> = {};
  for (const user of users) {
    usersMap[user.id] = user;
  }

  const res = await fetch(`${STREAM_CHAT_API_BASE}/users?api_key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stream-Auth-Type': 'jwt',
      Authorization: serverToken,
    },
    body: JSON.stringify({ users: usersMap }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Stream Chat upsertUsers failed (${res.status}): ${body}`);
  }
}

/**
 * Get or create a Stream Chat channel.
 * Idempotent: safe to call on an existing channel.
 */
export async function getOrCreateStreamChatChannel(
  apiKey: string,
  serverToken: string,
  channelType: string,
  channelId: string,
  data: { created_by_id: string; members: string[]; name?: string }
): Promise<void> {
  const res = await fetch(
    `${STREAM_CHAT_API_BASE}/channels/${channelType}/${channelId}/query?api_key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stream-Auth-Type': 'jwt',
        Authorization: serverToken,
      },
      body: JSON.stringify({ data }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Stream Chat getOrCreateChannel failed (${res.status}): ${body}`);
  }
}

/**
 * Provision the default Stream Chat channel for a new KiloClaw instance.
 *
 * Creates (or re-uses if already existing):
 *  - A human user with ID `{sandboxId}`
 *  - A per-instance bot user with ID `bot-{sandboxId}`
 *  - A messaging channel `default-{sandboxId}` with both as members
 *
 * Returns tokens and IDs needed to configure the machine and optionally the browser client.
 */
export async function setupDefaultStreamChatChannel(
  apiKey: string,
  apiSecret: string,
  sandboxId: string
): Promise<StreamChatSetup> {
  const serverToken = await createServerToken(apiSecret);

  const humanUserId = sandboxId;
  const botUserId = `bot-${sandboxId}`;
  const channelId = `default-${sandboxId}`;

  // Create/upsert both users
  await upsertStreamChatUsers(apiKey, serverToken, [
    { id: humanUserId, name: 'KiloClaw User' },
    { id: botUserId, name: 'KiloClaw Assistant', role: 'admin' },
  ]);

  // Create the default channel with both members
  await getOrCreateStreamChatChannel(apiKey, serverToken, 'messaging', channelId, {
    created_by_id: humanUserId,
    members: [humanUserId, botUserId],
    name: 'KiloClaw Chat',
  });

  // Generate tokens for both users
  const [botUserToken, userToken] = await Promise.all([
    createUserToken(apiSecret, botUserId),
    createUserToken(apiSecret, humanUserId),
  ]);

  return { apiKey, botUserId, botUserToken, channelId, userToken };
}
