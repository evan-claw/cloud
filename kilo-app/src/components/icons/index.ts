
import { DiscordIcon } from './discord-icon';
import { GitHubIcon } from './github-icon';
import { SlackIcon } from './slack-icon';
import { TelegramIcon } from './telegram-icon';
import { type BrandIconComponent } from './types';

export { GmailIcon } from './gmail-icon';
export { GoogleIcon } from './google-icon';

export const CHANNEL_ICONS: Partial<Record<string, BrandIconComponent>> = {
  telegram: TelegramIcon,
  discord: DiscordIcon,
  slack: SlackIcon,
  github: GitHubIcon,
};
