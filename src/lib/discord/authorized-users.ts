const AUTHORIZED_DISCORD_USERS_KEY = 'authorized_discord_users';

type MetadataRecord = Record<string, unknown>;

function isMetadataRecord(value: unknown): value is MetadataRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getAuthorizedDiscordUsers(metadata: unknown): Record<string, string> {
  if (!isMetadataRecord(metadata)) {
    return {};
  }

  const value = metadata[AUTHORIZED_DISCORD_USERS_KEY];
  if (!isMetadataRecord(value)) {
    return {};
  }

  const authorizedUsers: Record<string, string> = {};
  for (const [discordUserId, kiloUserId] of Object.entries(value)) {
    if (typeof kiloUserId === 'string' && kiloUserId.length > 0) {
      authorizedUsers[discordUserId] = kiloUserId;
    }
  }

  return authorizedUsers;
}

export function linkAuthorizedDiscordUser(
  metadata: unknown,
  params: { discordUserId: string; kiloUserId: string }
): Record<string, unknown> {
  const nextMetadata = isMetadataRecord(metadata) ? { ...metadata } : {};
  const existingAuthorizedUsers = getAuthorizedDiscordUsers(metadata);

  nextMetadata[AUTHORIZED_DISCORD_USERS_KEY] = {
    ...existingAuthorizedUsers,
    [params.discordUserId]: params.kiloUserId,
  };

  return nextMetadata;
}

export function getAuthorizedKiloUserIdForDiscordUser(
  metadata: unknown,
  discordUserId: string
): string | null {
  const authorizedUsers = getAuthorizedDiscordUsers(metadata);
  return authorizedUsers[discordUserId] || null;
}
