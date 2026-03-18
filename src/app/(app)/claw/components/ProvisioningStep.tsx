'use client';

import { useEffect, useRef } from 'react';
import { Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { useReadFile } from '@/hooks/useKiloClaw';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  type ExecPreset,
  type ClawMutations,
  OPENCLAW_CONFIG_PATH,
  mergeExecPreset,
} from './claw.types';

/** Play a short chime via the Web Audio API. */
function playChime() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {
    // Audio context creation can fail silently in some browsers
  }
}

export function ProvisioningStep({
  preset,
  instanceRunning,
  mutations,
  onComplete,
}: {
  preset: ExecPreset;
  instanceRunning: boolean;
  mutations: ClawMutations;
  onComplete: () => void;
}) {
  const completedRef = useRef(false);

  // Keep stable references to callbacks so the effect only re-runs
  // when data values change, not when the parent re-renders or mutation
  // state transitions (pending→error) produce new object references.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const writeFileRef = useRef(mutations.writeFile.mutate);
  writeFileRef.current = mutations.writeFile.mutate;

  const needsPatch = preset === 'never-ask';
  const {
    data: fileData,
    error: fileError,
    refetch,
  } = useReadFile(OPENCLAW_CONFIG_PATH, instanceRunning && needsPatch);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  const fileNotFound = fileError?.data?.code === 'NOT_FOUND';

  useEffect(() => {
    if (!instanceRunning || completedRef.current) return;

    if (preset === 'always-ask') {
      completedRef.current = true;
      playChime();
      onCompleteRef.current();
      return;
    }

    // "never-ask" — wait for config file to load, or confirm it doesn't exist yet
    if (!fileData && !fileNotFound) return;

    completedRef.current = true;

    let currentConfig: Record<string, unknown> = {};
    if (fileData) {
      try {
        const parsed: unknown = JSON.parse(fileData.content);
        currentConfig = (
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
        ) as Record<string, unknown>;
      } catch {
        toast.error('Failed to parse config — please try again');
        completedRef.current = false;
        return;
      }
    }

    const merged = mergeExecPreset(currentConfig, preset);
    writeFileRef.current(
      {
        path: OPENCLAW_CONFIG_PATH,
        content: JSON.stringify(merged, null, 2),
        ...(fileData ? { etag: fileData.etag } : {}),
      },
      {
        onSuccess: () => {
          playChime();
          onCompleteRef.current();
        },
        onError: (err: {
          message: string;
          data?: { code?: string; upstreamCode?: string } | null;
        }) => {
          completedRef.current = false;
          if (err.data?.code === 'CONFLICT') {
            void refetchRef.current();
            toast.error('Config was modified externally — please try again');
          } else {
            toast.error(err.message);
          }
        },
      }
    );
  }, [instanceRunning, preset, fileData, fileNotFound]);

  return (
    <Card className="mt-6">
      <CardContent className="flex flex-col items-center gap-8 p-6 pt-10 sm:p-10 sm:pt-12">
        {/* Step indicator */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            Almost there...
          </span>
          <div className="flex gap-1">
            <span className="h-1.5 w-6 rounded-full bg-blue-500" />
            <span className="h-1.5 w-6 rounded-full bg-blue-500" />
            <span className="h-1.5 w-6 rounded-full bg-blue-500" />
          </div>
        </div>

        {/* Spinner */}
        <div className="provisioning-spinner relative h-24 w-24">
          <svg className="h-full w-full" viewBox="0 0 96 96">
            {/* Gray track */}
            <circle
              cx="48"
              cy="48"
              r="42"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              className="text-muted/40"
            />
            {/* Blue arc */}
            <circle
              cx="48"
              cy="48"
              r="42"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray="132 264"
              className="provisioning-spinner-arc text-blue-500"
            />
            {/* Blue dot at the leading edge of the arc */}
            <circle cx="48" cy="6" r="4" fill="currentColor" className="text-blue-500" />
          </svg>
          <style>{`
            .provisioning-spinner svg {
              animation: provisioning-rotate 1.4s linear infinite;
            }
            @keyframes provisioning-rotate {
              to { transform: rotate(360deg); }
            }
          `}</style>
        </div>

        {/* Heading + subtitle */}
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-foreground text-2xl font-bold">Setting up your instance</h2>
          <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
            This usually takes a minute or two. Feel free to keep this tab open and step away
            &mdash; we&apos;ll play a sound as soon as it&apos;s ready.
          </p>
        </div>

        {/* Sound banner */}
        <div className="border-border flex w-full items-center gap-3 rounded-lg border p-4">
          <Volume2 className="text-muted-foreground h-5 w-5 shrink-0" />
          <span className="text-muted-foreground flex-1 text-sm">
            You&apos;ll hear a chime when your instance is ready.
          </span>
          <Button variant="ghost" size="sm" onClick={playChime}>
            Play test sound
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
