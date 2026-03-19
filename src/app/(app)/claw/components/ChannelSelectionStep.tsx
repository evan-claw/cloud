'use client';

import { useState } from 'react';
import { ChevronRight, ExternalLink, PlayCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { DiscordIcon } from './icons/DiscordIcon';
import { ChannelTokenInput } from './ChannelTokenInput';
import SlackIcon from '@/app/(app)/claw/components/icons/SlackIcon';
import TelegramIcon from '@/app/(app)/claw/components/icons/TelegramIcon';

type ChannelId = 'telegram' | 'discord' | 'slack';

type ChannelOption = {
  id: ChannelId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  effort: 1 | 2 | 3;
  effortColor: 'emerald' | 'amber';
  recommended?: boolean;
};

const CHANNEL_OPTIONS: ChannelOption[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    icon: TelegramIcon,
    description:
      'Chat with your bot directly in Telegram. Just open a conversation with it \u2014 no workspace, no admin access, ready in seconds.',
    effort: 1,
    effortColor: 'emerald',
    recommended: true,
  },
  {
    id: 'discord',
    label: 'Discord',
    icon: DiscordIcon,
    description:
      'Talk to your bot in a Discord server channel. Requires adding it as a bot to your server.',
    effort: 3,
    effortColor: 'amber',
  },
  {
    id: 'slack',
    label: 'Slack',
    icon: SlackIcon,
    description:
      'Talk to your bot in a Slack channel. Requires installing it as an app in your workspace.',
    effort: 3,
    effortColor: 'amber',
  },
];

export function ChannelSelectionStep({
  onSelect,
  onSkip,
}: {
  onSelect: (channelId: ChannelId) => void;
  onSkip: () => void;
}) {
  return <ChannelSelectionStepView onSelect={onSelect} onSkip={onSkip} />;
}

/** Pure visual shell — extracted so Storybook can render it without wiring up mutations. */
export function ChannelSelectionStepView({
  onSelect,
  onSkip,
}: {
  onSelect?: (channelId: ChannelId) => void;
  onSkip?: () => void;
}) {
  const [selected, setSelected] = useState<ChannelId | null>(null);
  const [tokens, setTokens] = useState<Record<string, string>>({});

  const telegram = CHANNEL_OPTIONS[0];
  const others = CHANNEL_OPTIONS.slice(1);

  function setToken(key: string, value: string) {
    setTokens(prev => ({ ...prev, [key]: value }));
  }

  return (
    <Card className="mt-6">
      <CardContent className="flex flex-col gap-6 p-6 sm:p-8">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Step 3 of 4
            </span>
            <div className="flex gap-1">
              <span className="h-1.5 w-6 rounded-full bg-blue-500" />
              <span className="h-1.5 w-6 rounded-full bg-blue-500" />
              <span className="h-1.5 w-6 rounded-full bg-blue-500" />
              <span className="bg-muted h-1.5 w-6 rounded-full" />
            </div>
          </div>
          <h2 className="text-foreground text-2xl font-bold">Where do you want to chat?</h2>
          <p className="text-muted-foreground text-sm">
            Pick where you&apos;d like to talk to your KiloClaw bot. You can add more channels any
            time from settings.
          </p>
        </div>

        {telegram && (
          <ChannelCard
            option={telegram}
            isSelected={selected === telegram.id}
            onSelect={() => setSelected(telegram.id)}
            expandedContent={
              <TelegramSetupSection
                token={tokens.telegramBotToken ?? ''}
                onTokenChange={v => setToken('telegramBotToken', v)}
              />
            }
          />
        )}

        <div className="flex items-center gap-3">
          <div className="border-border flex-1 border-t" />
          <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            Other options
          </span>
          <div className="border-border flex-1 border-t" />
        </div>

        {others.map(option => (
          <ChannelCard
            key={option.id}
            option={option}
            isSelected={selected === option.id}
            onSelect={() => setSelected(option.id)}
          />
        ))}

        <Button
          className="w-full bg-emerald-600 py-6 text-base text-white hover:bg-emerald-700"
          disabled={selected === null}
          onClick={() => selected && onSelect?.(selected)}
        >
          Continue
          <ChevronRight className="ml-1 h-5 w-5" />
        </Button>

        <button
          type="button"
          className="text-muted-foreground hover:text-foreground mx-auto text-sm transition-colors"
          onClick={() => onSkip?.()}
        >
          Skip for now
        </button>
      </CardContent>
    </Card>
  );
}

function ChannelCard({
  option,
  isSelected,
  onSelect,
  expandedContent,
}: {
  option: ChannelOption;
  isSelected: boolean;
  onSelect: () => void;
  expandedContent?: React.ReactNode;
}) {
  const Icon = option.icon;

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-xl border transition-colors',
        isSelected ? 'border-blue-500/60' : 'border-border hover:border-muted-foreground/40'
      )}
      style={isSelected ? { backgroundColor: '#4f7fff14' } : undefined}
    >
      <button type="button" onClick={onSelect} className="flex cursor-pointer gap-4 p-5 text-left">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: isSelected ? '#229ed933' : 'var(--color-muted)' }}
        >
          <Icon className="h-6 w-6" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold">{option.label}</span>
            {option.recommended && (
              <span className="rounded-full border border-emerald-700 px-2.5 py-0.5 text-[10px] font-semibold tracking-wider text-emerald-400 uppercase">
                Recommended
              </span>
            )}
          </div>
          <p className="text-xs leading-relaxed text-[#5a5b64]">{option.description}</p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <EffortIndicator level={option.effort} color={option.effortColor} />
          <RadioIndicator checked={isSelected} />
        </div>
      </button>

      {isSelected && expandedContent && <div className="px-5 pb-5">{expandedContent}</div>}
    </div>
  );
}

function TelegramSetupSection({
  token,
  onTokenChange,
}: {
  token: string;
  onTokenChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="border-border border-t" />

      <h3 className="text-muted-foreground text-sm font-bold tracking-wider uppercase">
        Create your bot token
      </h3>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <StepNumber n={1} />
          <p className="text-muted-foreground text-sm leading-relaxed">
            Open Telegram and start a chat with{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300"
            >
              @BotFather
              <ExternalLink className="mb-0.5 ml-0.5 inline h-3 w-3" />
            </a>{' '}
            &mdash; make sure the handle is exactly{' '}
            <strong className="text-foreground">@BotFather</strong>.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <StepNumber n={2} />
          <p className="text-muted-foreground text-sm leading-relaxed">
            Run{' '}
            <code className="rounded bg-purple-900/40 px-1.5 py-0.5 text-purple-300">/newbot</code>,
            follow the prompts, and copy the token it gives you.
          </p>
        </div>
      </div>

      <a
        href="https://youtu.be/t2iTYbDsSds"
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-muted-foreground flex items-center gap-2 text-xs text-[#5a5b64] transition-colors"
      >
        <PlayCircle className="h-5 w-5 shrink-0 text-blue-400" />
        Prefer a walkthrough? Watch a short video guide
      </a>

      <ChannelTokenInput
        id="onboarding-telegram-token"
        placeholder="Paste your bot token here"
        value={token}
        onChange={onTokenChange}
        maxLength={100}
      />
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="bg-muted text-muted-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
      {n}
    </span>
  );
}

function RadioIndicator({ checked }: { checked: boolean }) {
  return (
    <div
      className={cn(
        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
        checked ? 'border-blue-500 bg-blue-500' : 'border-muted-foreground/40'
      )}
    >
      {checked && <div className="h-2 w-2 rounded-full bg-white" />}
    </div>
  );
}

function EffortIndicator({ level, color }: { level: 1 | 2 | 3; color: 'emerald' | 'amber' }) {
  const filledClass = color === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500';

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">Effort</span>
      <div className="flex gap-1">
        {[1, 2, 3].map(i => (
          <span
            key={i}
            className={cn('h-2 w-4 rounded-full', i <= level ? filledClass : 'bg-muted')}
          />
        ))}
      </div>
    </div>
  );
}
