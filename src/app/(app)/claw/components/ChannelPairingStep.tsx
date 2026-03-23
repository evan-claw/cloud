'use client';

import { useEffect, useRef } from 'react';
import { Check, Loader2, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { useKiloClawPairing, useRefreshPairing } from '@/hooks/useKiloClaw';
import { Button } from '@/components/ui/button';
import type { ClawMutations } from './claw.types';
import { OnboardingStepView } from './OnboardingStepView';
import { TelegramIcon } from './icons/TelegramIcon';
import { DiscordIcon } from './icons/DiscordIcon';

type PairingChannelId = 'telegram' | 'discord';

const CHANNEL_META: Record<
  PairingChannelId,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    instruction: string;
  }
> = {
  telegram: {
    label: 'Telegram',
    icon: TelegramIcon,
    instruction:
      'Open Telegram and send any message to your bot. The bot will reply with a pairing request — we\u2019ll pick it up automatically.',
  },
  discord: {
    label: 'Discord',
    icon: DiscordIcon,
    instruction:
      'Open Discord and send a DM to your bot. The bot will reply with a pairing request — we\u2019ll pick it up automatically.',
  },
};

// ── Stateful wrapper (hooks + mutations) ────────────────────────────

export function ChannelPairingStep({
  channelId,
  mutations,
  onComplete,
  onSkip,
}: {
  channelId: PairingChannelId;
  mutations: ClawMutations;
  onComplete: () => void;
  onSkip: () => void;
}) {
  // Subscribe to the normal pairing query (shared cache with Settings tab)
  const { data: pairingData } = useKiloClawPairing(true);

  // Bust the KV cache every 5 seconds so new requests appear quickly.
  // useRefreshPairing returns a fresh closure each render, so pin it in a ref
  // to keep the interval stable.
  const refreshPairing = useRefreshPairing();
  const refreshRef = useRef(refreshPairing);
  refreshRef.current = refreshPairing;

  useEffect(() => {
    refreshRef.current().catch(() => {});
    const id = setInterval(() => {
      refreshRef.current().catch(() => {});
    }, 5_000);
    return () => clearInterval(id);
  }, []);

  // Find the first pairing request matching this channel
  const matchingRequest = pairingData?.requests?.find(
    (r: { channel: string; code: string; id: string }) => r.channel === channelId
  );

  const isApproving = mutations.approvePairingRequest.isPending;

  function handleApprove(channel: string, code: string) {
    mutations.approvePairingRequest.mutate(
      { channel, code },
      {
        onSuccess: result => {
          if (result.success) {
            toast.success('Pairing approved');
            onComplete();
          } else {
            toast.error(result.message || 'Approval failed');
          }
        },
        onError: err => toast.error(`Failed to approve: ${err.message}`),
      }
    );
  }

  return (
    <ChannelPairingStepView
      channelId={channelId}
      matchingRequest={matchingRequest ?? null}
      isApproving={isApproving}
      onApprove={handleApprove}
      onSkip={onSkip}
    />
  );
}

type ChannelPairingStepViewProps = {
  channelId: PairingChannelId;
  matchingRequest: { code: string; channel: string; id: string } | null;
  isApproving?: boolean;
  onApprove?: (channel: string, code: string) => void;
  onSkip?: () => void;
};

export function ChannelPairingStepView({
  channelId,
  matchingRequest,
  isApproving = false,
  onApprove,
  onSkip,
}: ChannelPairingStepViewProps) {
  const meta = CHANNEL_META[channelId];

  if (matchingRequest) {
    return (
      <OnboardingStepView
        currentStep={5}
        totalSteps={5}
        title={`Pair your ${meta.label} bot`}
        description="A pairing request was detected — approve it to link your account."
        contentClassName="gap-8"
      >
        <div className="border-border flex items-center justify-between rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <MessageSquare className="text-muted-foreground h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                  {matchingRequest.code}
                </span>
                <span className="text-muted-foreground text-xs capitalize">
                  {matchingRequest.channel}
                </span>
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">User {matchingRequest.id}</p>
            </div>
          </div>
          <Button
            size="sm"
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => onApprove?.(matchingRequest.channel, matchingRequest.code)}
            disabled={isApproving}
          >
            {isApproving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            Approve
          </Button>
        </div>

        <button
          type="button"
          className="text-muted-foreground/50 hover:text-muted-foreground mx-auto text-sm transition-colors"
          onClick={onSkip}
        >
          Skip — I&apos;ll pair later from Settings
        </button>
      </OnboardingStepView>
    );
  }

  return (
    <OnboardingStepView
      currentStep={5}
      totalSteps={5}
      title={`Pair your ${meta.label} bot`}
      description={meta.instruction}
      contentClassName="gap-8"
    >
      <div className="flex flex-col items-center gap-8">
        <div className="pairing-spinner relative h-24 w-24 my-6">
          <svg className="h-full w-full" viewBox="0 0 96 96">
            <circle
              cx="48"
              cy="48"
              r="42"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              className="text-muted/40"
            />
            <circle
              cx="48"
              cy="48"
              r="42"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray="132 264"
              className="pairing-spinner-arc text-blue-500"
            />
          </svg>
          <style>{`
            .pairing-spinner svg {
              animation: pairing-rotate 1.4s linear infinite;
            }
            @keyframes pairing-rotate {
              to { transform: rotate(360deg); }
            }
          `}</style>
        </div>

        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-foreground text-lg font-semibold">
            Waiting for you to message the bot...
          </h2>
          <p className="text-muted-foreground text-sm">
            This page will update as soon as the bot responds
          </p>
        </div>

        <button
          type="button"
          className="text-muted-foreground/50 cursor-pointer hover:text-muted-foreground text-sm transition-colors my-6"
          onClick={onSkip}
        >
          Skip — I&apos;ll pair later from Settings
        </button>
      </div>
    </OnboardingStepView>
  );
}
