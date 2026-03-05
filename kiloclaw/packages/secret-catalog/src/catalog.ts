import type { SecretCatalogEntry, SecretCategory } from './types.js';

/**
 * Secret Catalog — declarative registry of all secret types.
 *
 * Migrated from cloud/src/app/(app)/claw/components/channel-config.tsx
 */
export const SECRET_CATALOG: readonly SecretCatalogEntry[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    category: 'channel',
    icon: 'send',
    order: 1,
    fields: [
      {
        key: 'telegramBotToken',
        label: 'Bot Token',
        placeholder: '123456:ABC-DEF...',
        placeholderConfigured: 'Enter new token to replace',
        envVar: 'TELEGRAM_BOT_TOKEN',
        validationPattern: '^\\d{8,}:[A-Za-z0-9_-]{30,50}$',
        validationMessage:
          'Telegram tokens look like 123456789:ABCDefGhIJKlmn... (digits, colon, then letters/numbers).',
        maxLength: 100,
      },
    ],
    helpText: 'Get a token from @BotFather on Telegram.',
    helpUrl: 'https://t.me/BotFather',
  },
  {
    id: 'discord',
    label: 'Discord',
    category: 'channel',
    icon: 'discord',
    order: 2,
    fields: [
      {
        key: 'discordBotToken',
        label: 'Bot Token',
        placeholder: 'MTIz...',
        placeholderConfigured: 'Enter new token to replace',
        envVar: 'DISCORD_BOT_TOKEN',
        // Note: {24,}? uses lazy quantifier (preserved from original channel-config.tsx).
        // With ^...$ anchors, lazy vs greedy doesn't affect correctness, only backtracking.
        validationPattern: '^[A-Za-z\\d_-]{24,}?\\.[A-Za-z\\d_-]{4,}\\.[A-Za-z\\d_-]{25,}$',
        validationMessage:
          'Discord tokens have three dot-separated parts, like MTIz...abc.XYZ123.abcdef...',
        maxLength: 200,
      },
    ],
    helpText: 'Get a token from the Discord Developer Portal.',
    helpUrl: 'https://discord.com/developers/applications',
  },
  {
    id: 'slack',
    label: 'Slack',
    category: 'channel',
    icon: 'slack',
    order: 3,
    allFieldsRequired: true,
    fields: [
      {
        key: 'slackBotToken',
        label: 'Bot Token',
        placeholder: 'xoxb-...',
        placeholderConfigured: 'Enter new bot token to replace',
        envVar: 'SLACK_BOT_TOKEN',
        validationPattern: '^xoxb-[A-Za-z0-9-]{20,255}$',
        validationMessage: 'Slack bot tokens start with xoxb- (not xoxp- or xapp-).',
        maxLength: 300,
      },
      {
        key: 'slackAppToken',
        label: 'App Token',
        placeholder: 'xapp-...',
        placeholderConfigured: 'Enter new app token to replace',
        envVar: 'SLACK_APP_TOKEN',
        validationPattern: '^xapp-[A-Za-z0-9-]{20,255}$',
        validationMessage: 'Slack app tokens start with xapp- (not xoxb- or xoxp-).',
        maxLength: 300,
      },
    ],
    helpText: 'Get tokens from Slack App Management. Both Bot Token and App Token are required.',
    helpUrl: 'https://api.slack.com/apps',
  },
];

// Lookup helpers

/** Map of entry ID → entry */
export const SECRET_CATALOG_MAP: ReadonlyMap<string, SecretCatalogEntry> = new Map(
  SECRET_CATALOG.map(entry => [entry.id, entry])
);

/** Set of all field keys across all entries */
export const ALL_SECRET_FIELD_KEYS: ReadonlySet<string> = new Set(
  SECRET_CATALOG.flatMap(entry => entry.fields.map(field => field.key))
);

/** Map of field key → env var name */
export const FIELD_KEY_TO_ENV_VAR: ReadonlyMap<string, string> = new Map(
  SECRET_CATALOG.flatMap(entry => entry.fields.map(field => [field.key, field.envVar]))
);

/** Map of field key → owning entry (used for allFieldsRequired checks) */
export const FIELD_KEY_TO_ENTRY: ReadonlyMap<string, SecretCatalogEntry> = new Map(
  SECRET_CATALOG.flatMap(entry => entry.fields.map(field => [field.key, entry]))
);

/**
 * Get all entries for a given category, sorted by order (undefined sorts last).
 */
export function getEntriesByCategory(category: SecretCategory): SecretCatalogEntry[] {
  return SECRET_CATALOG.filter(entry => entry.category === category).sort((a, b) => {
    const orderA = a.order ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.order ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });
}
