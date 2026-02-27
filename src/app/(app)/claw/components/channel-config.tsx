import React from 'react';
import { Send, Slack } from 'lucide-react';
import { DiscordIcon } from './icons/DiscordIcon';

export type ChannelType = 'telegram' | 'discord' | 'slack';

type ChannelField = {
  key: string;
  label: string;
  placeholder: string;
  placeholderConfigured: string;
  /** Client-side format check run on Save. Returns an error hint or null if valid. */
  validate?: (value: string) => string | null;
};

export type ChannelDefinition = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  fields: ChannelField[];
  configuredCheck: (channels: {
    telegram: boolean;
    discord: boolean;
    slackBot: boolean;
    slackApp: boolean;
  }) => boolean;
  help: React.ReactNode;
};

// Telegram: {8-10 digit bot ID}:{30-50 base64url chars}
const TELEGRAM_TOKEN_RE = /^\d{8,10}:[A-Za-z0-9_-]{30,50}$/;
// Discord: three dot-separated base64url segments
const DISCORD_TOKEN_RE = /^[A-Za-z\d_-]{24,}?\.[A-Za-z\d_-]{4,}\.[A-Za-z\d_-]{25,}$/;
// Slack bot token: xoxb- prefix
const SLACK_BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{20,255}$/;
// Slack app-level token: xapp- prefix
const SLACK_APP_TOKEN_RE = /^xapp-[A-Za-z0-9-]{20,255}$/;

export const CHANNELS: Record<ChannelType, ChannelDefinition> = {
  telegram: {
    label: 'Telegram',
    icon: Send,
    fields: [
      {
        key: 'telegramBotToken',
        label: 'Bot Token',
        placeholder: '123456:ABC-DEF...',
        placeholderConfigured: 'Enter new token to replace',
        validate: v =>
          TELEGRAM_TOKEN_RE.test(v)
            ? null
            : 'Telegram tokens look like 123456789:ABCDefGhIJKlmn... (digits, colon, then letters/numbers).',
      },
    ],
    configuredCheck: ch => ch.telegram,
    help: (
      <>
        Get a token from{' '}
        <a
          href="https://t.me/BotFather"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          @BotFather
        </a>{' '}
        on Telegram.
      </>
    ),
  },
  discord: {
    label: 'Discord',
    icon: DiscordIcon,
    fields: [
      {
        key: 'discordBotToken',
        label: 'Bot Token',
        placeholder: 'MTIz...',
        placeholderConfigured: 'Enter new token to replace',
        validate: v =>
          DISCORD_TOKEN_RE.test(v)
            ? null
            : 'Discord tokens have three dot-separated parts, like MTIz...abc.XYZ123.abcdef...',
      },
    ],
    configuredCheck: ch => ch.discord,
    help: (
      <>
        Get a token from the{' '}
        <a
          href="https://discord.com/developers/applications"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Discord Developer Portal
        </a>
        .
      </>
    ),
  },
  slack: {
    label: 'Slack',
    icon: Slack,
    fields: [
      {
        key: 'slackBotToken',
        label: 'Bot Token',
        placeholder: 'xoxb-...',
        placeholderConfigured: 'Enter new bot token to replace',
        validate: v =>
          SLACK_BOT_TOKEN_RE.test(v)
            ? null
            : 'Slack bot tokens start with xoxb- (not xoxp- or xapp-).',
      },
      {
        key: 'slackAppToken',
        label: 'App Token',
        placeholder: 'xapp-...',
        placeholderConfigured: 'Enter new app token to replace',
        validate: v =>
          SLACK_APP_TOKEN_RE.test(v)
            ? null
            : 'Slack app tokens start with xapp- (not xoxb- or xoxp-).',
      },
    ],
    configuredCheck: ch => ch.slackBot && ch.slackApp,
    help: (
      <>
        Get tokens from{' '}
        <a
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Slack App Management
        </a>
        . Both Bot Token and App Token are required.
      </>
    ),
  },
};

export const CHANNEL_TYPES: ChannelType[] = ['telegram', 'discord', 'slack'];
