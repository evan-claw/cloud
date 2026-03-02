import { describe, expect, test } from '@jest/globals';
import {
  getAuthorizedDiscordUsers,
  getAuthorizedKiloUserIdForDiscordUser,
  linkAuthorizedDiscordUser,
} from '@/lib/discord/authorized-users';

describe('authorized Discord users metadata', () => {
  test('returns empty map for invalid metadata', () => {
    expect(getAuthorizedDiscordUsers(null)).toEqual({});
    expect(getAuthorizedDiscordUsers('invalid')).toEqual({});
    expect(getAuthorizedDiscordUsers({ authorized_discord_users: 'invalid' })).toEqual({});
  });

  test('links a Discord user while preserving existing links', () => {
    const metadata = {
      authorized_discord_users: {
        'discord-user-1': 'kilo-user-1',
      },
      model_slug: 'model-1',
    };

    const updatedMetadata = linkAuthorizedDiscordUser(metadata, {
      discordUserId: 'discord-user-2',
      kiloUserId: 'kilo-user-2',
    });

    expect(getAuthorizedDiscordUsers(updatedMetadata)).toEqual({
      'discord-user-1': 'kilo-user-1',
      'discord-user-2': 'kilo-user-2',
    });
  });

  test('returns linked Kilo user id for a Discord user', () => {
    const metadata = {
      authorized_discord_users: {
        'discord-user-1': 'kilo-user-1',
      },
    };

    expect(getAuthorizedKiloUserIdForDiscordUser(metadata, 'discord-user-1')).toBe('kilo-user-1');
    expect(getAuthorizedKiloUserIdForDiscordUser(metadata, 'discord-user-2')).toBeNull();
  });
});
