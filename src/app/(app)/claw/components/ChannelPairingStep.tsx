'use client';

import { useEffect, useRef } from 'react';
import { Check, Loader2, MessageSquare, ShieldCheck } from 'lucide-react';
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
    instruction: 'Open Telegram and send any message to your bot.',
  },
  discord: {
    label: 'Discord',
    icon: DiscordIcon,
    instruction: 'Open Discord and send a DM to your bot.',
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
  const { data: pairingData, isLoading } = useKiloClawPairing(true);

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
      isLoading={isLoading}
      isApproving={isApproving}
      onApprove={handleApprove}
      onSkip={onSkip}
    />
  );
}

// ── Pure visual component (no hooks — Storybook-friendly) ───────────

type ChannelPairingStepViewProps = {
  channelId: PairingChannelId;
  matchingRequest: { code: string; channel: string; id: string } | null;
  isLoading?: boolean;
  isApproving?: boolean;
  onApprove?: (channel: string, code: string) => void;
  onSkip?: () => void;
};

export function ChannelPairingStepView({
  channelId,
  matchingRequest,
  isLoading = false,
  isApproving = false,
  onApprove,
  onSkip,
}: ChannelPairingStepViewProps) {
  const meta = CHANNEL_META[channelId];
  const Icon = meta.icon;

  return (
    <OnboardingStepView
      currentStep={5}
      totalSteps={5}
      title="Pair your account"
      description={`Before you can chat, ${meta.label} needs to verify it's really you.`}
      contentClassName="gap-8"
    >
      {/* Instruction card */}
      <div className="border-border flex items-start gap-4 rounded-lg border p-5">
        <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-foreground text-sm font-semibold">{meta.instruction}</p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Your bot will see the message and create a pairing request that appears below.
          </p>
        </div>
      </div>

      {/* Pairing request area */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-muted-foreground h-4 w-4" />
          <span className="text-foreground text-sm font-semibold">Pairing request</span>
        </div>

        {matchingRequest ? (
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
        ) : (
          <div className="border-border flex items-center gap-3 rounded-lg border border-dashed p-4">
            {isLoading ? (
              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            ) : (
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
              </span>
            )}
            <span className="text-muted-foreground text-sm">
              Waiting for a message from {meta.label}...
            </span>
          </div>
        )}
      </div>

      {/* Skip link */}
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground mx-auto text-sm transition-colors"
        onClick={onSkip}
      >
        Skip — I&apos;ll pair later from Settings
      </button>
    </OnboardingStepView>
  );
}
