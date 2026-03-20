import { DISCORD_BOT_TOKEN, DISCORD_SERVER_ID } from '@/lib/config.server';

/**
 * Check if a Discord user is a member of the Kilo Discord server.
 * Uses the Discord Bot API — requires the bot to be in the target guild.
 *
 * Returns true if the user is a guild member, false if not (404), and
 * throws on unexpected API errors.
 */
export async function checkDiscordGuildMembership(discordUserId: string): Promise<boolean> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_SERVER_ID) {
    throw new Error('Discord bot token or server ID not configured');
  }

  const response = await fetch(
    `https://discord.com/api/v10/guilds/${DISCORD_SERVER_ID}/members/${discordUserId}`,
    {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
    }
  );

  if (response.ok) return true;
  if (response.status === 404) return false;

  throw new Error(`Discord API error: ${response.status} ${response.statusText}`);
}
