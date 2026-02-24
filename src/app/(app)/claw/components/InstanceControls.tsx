'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, RotateCw, Square, Stethoscope } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { Button } from '@/components/ui/button';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { RunDoctorDialog } from './RunDoctorDialog';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

const openclawPhrases = [
  "If it works, it's automation; if it breaks, it's a 'learning opportunity.'",
  'I speak fluent bash, mild sarcasm, and aggressive tab-completion energy.',
  'I can grep it, git blame it, and gently roast it—pick your coping mechanism.',
  "I'm the reason your shell history looks like a hacker-movie montage.",
  "I'm like tmux: confusing at first, then suddenly you can't live without me.",
  'I can run local, remote, or purely on vibes—results may vary with DNS.',
  'If you can describe it, I can probably automate it—or at least make it funnier.',
  'Your config is valid, your assumptions are not.',
  "I'll refactor your busywork like it owes me money.",
  "Say 'stop' and I'll stop—say 'ship' and we'll both learn a lesson.",
  "I'll do the boring stuff while you dramatically stare at the logs like it's cinema.",
  "I'm not saying your workflow is chaotic... I'm just bringing a linter and a helmet.",
  'Type the command with confidence—nature will provide the stack trace if needed.',
  "I run on caffeine, JSON5, and the audacity of 'it worked on my machine.'",
  'Gateway online—please keep hands, feet, and appendages inside the shell at all times.',
  "Give me a workspace and I'll give you fewer tabs, fewer toggles, and more oxygen.",
  "It's not 'failing,' it's 'discovering new ways to configure the same thing wrong.'",
  "I can't fix your code taste, but I can fix your build and your backlog.",
  "I'm not magic—I'm just extremely persistent with retries and coping strategies.",
  "I'm basically a Swiss Army knife, but with more opinions and fewer sharp edges.",
  "If you're lost, run doctor; if you're brave, run prod; if you're wise, run tests.",
  'Your terminal just grew claws—type something and let the bot pinch the busywork.',
  'Welcome to the command line: where dreams compile and confidence segfaults.',
  'The UNIX philosophy meets your DMs.',
  'curl for conversations.',
  'Less middlemen, more messages.',
  'Ship fast, log faster.',
  'End-to-end encrypted, drama-to-drama excluded.',
  'The only bot that stays out of your training set.',
  'Because the right answer is usually a script.',
  'No $999 stand required.',
  'No Mac mini required',
  'Ah, the fruit tree company! 🍎',
  'Greetings, Professor Falken',
];

export function InstanceControls({
  status,
  mutations,
}: {
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
}) {
  const posthog = usePostHog();
  const isRunning = status.status === 'running';
  const isStopped = status.status === 'stopped' || status.status === 'provisioned';
  const isDestroying = status.status === 'destroying';
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [showBanner, setShowBanner] = useState(false);
  const bannerTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (mutations.start.isPending) {
      if (bannerTimeoutRef.current !== null) {
        window.clearTimeout(bannerTimeoutRef.current);
        bannerTimeoutRef.current = null;
      }
      setShowBanner(true);
      return;
    }

    if (!showBanner) {
      return;
    }

    bannerTimeoutRef.current = window.setTimeout(() => {
      setShowBanner(false);
      bannerTimeoutRef.current = null;
    }, 5000);

    return () => {
      if (bannerTimeoutRef.current !== null) {
        window.clearTimeout(bannerTimeoutRef.current);
        bannerTimeoutRef.current = null;
      }
    };
  }, [mutations.start.isPending, showBanner]);

  return (
    <div>
      <h3 className="text-foreground mb-1 text-sm font-medium">Instance Controls</h3>
      <p className="text-muted-foreground mb-4 text-xs">
        Manage power state and gateway lifecycle.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
          disabled={!isStopped || mutations.start.isPending || isDestroying}
          onClick={() => {
            posthog?.capture('claw_start_instance_clicked', { instance_status: status.status });
            setPhraseIndex(prevIndex => (prevIndex + 1) % openclawPhrases.length);
            mutations.start.mutate();
          }}
        >
          <Play className="h-4 w-4" />
          {mutations.start.isPending ? 'Starting...' : 'Start'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
          disabled={!isRunning || mutations.stop.isPending || isDestroying}
          onClick={() => {
            posthog?.capture('claw_stop_instance_clicked', { instance_status: status.status });
            mutations.stop.mutate(undefined, {
              onSuccess: () => toast.success('Instance stopped'),
              onError: err => toast.error(err.message),
            });
          }}
        >
          <Square className="h-4 w-4" />
          {mutations.stop.isPending ? 'Stopping...' : 'Stop'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
          disabled={!isRunning || mutations.restartGateway.isPending || isDestroying}
          onClick={() => {
            posthog?.capture('claw_redeploy_clicked', { instance_status: status.status });
            mutations.restartGateway.mutate(undefined, {
              onSuccess: () => toast.success('Gateway restarting'),
              onError: err => toast.error(err.message),
            });
          }}
        >
          <RotateCw className="h-4 w-4" />
          {mutations.restartGateway.isPending ? 'Redeploying...' : 'Redeploy'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 hover:text-cyan-300"
          disabled={!isRunning || mutations.runDoctor.isPending || isDestroying}
          onClick={() => {
            posthog?.capture('claw_doctor_clicked', { instance_status: status.status });
            setDoctorOpen(true);
          }}
        >
          <Stethoscope className="h-4 w-4" />
          OpenClaw Doctor
        </Button>
      </div>
      {showBanner ? (
        <div className="mt-2 flex items-center gap-2">
          <div className="claw-banner text-muted-foreground/90 border-muted-foreground/30 bg-muted/30 relative flex items-center gap-3 overflow-hidden rounded-full border px-3 py-1 text-xs">
            <span className="text-sm">🦞</span>
            <span className="text-sm">🦀</span>
            <span className="claw-fade" key={openclawPhrases[phraseIndex]}>
              {openclawPhrases[phraseIndex]}
            </span>
          </div>
          <style jsx>{`
            .claw-banner {
              animation: claw-spin 12s linear infinite;
            }

            .claw-fade {
              animation: claw-fade 3s ease-in-out infinite;
              white-space: nowrap;
            }

            @keyframes claw-spin {
              0% {
                transform: rotate(-1deg);
              }
              50% {
                transform: rotate(1deg);
              }
              100% {
                transform: rotate(-1deg);
              }
            }

            @keyframes claw-fade {
              0% {
                opacity: 0.15;
              }
              20% {
                opacity: 1;
              }
              80% {
                opacity: 1;
              }
              100% {
                opacity: 0.15;
              }
            }
          `}</style>
        </div>
      ) : null}
      <RunDoctorDialog
        open={doctorOpen}
        onOpenChange={setDoctorOpen}
        mutation={mutations.runDoctor}
      />
    </div>
  );
}
