'use client';

import { AlertCircle, ShieldAlert, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ExecPreset } from './claw.types';
import { OnboardingStepView } from './OnboardingStepView';

export function PermissionStep({
  instanceRunning,
  onSelect,
}: {
  instanceRunning: boolean;
  onSelect: (preset: ExecPreset) => void;
}) {
  return (
    <OnboardingStepView
      currentStep={2}
      totalSteps={4}
      title="Set Bot Permissions"
      description="Choose how your KiloClaw bot handles actions on your behalf."
      showProvisioningBanner={!instanceRunning}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PresetCard
          onClick={() => onSelect('never-ask')}
          icon={<ShieldAlert className="h-5 w-5 text-amber-400" />}
          iconBg="bg-amber-900/50"
          title="Allow everything"
          description="The bot acts immediately without asking — a.k.a. YOLO mode. Best for autonomous workflows, but review what it can access first."
          caution="Use with caution"
        />
        <PresetCard
          onClick={() => onSelect('always-ask')}
          icon={<ShieldCheck className="h-5 w-5 text-emerald-400" />}
          iconBg="bg-emerald-900/50"
          title="Ask for permission"
          description="The bot pauses and asks you before taking any action. Best when you want full control over what it does."
          badge="Recommended"
        />
      </div>
    </OnboardingStepView>
  );
}

function PresetCard({
  onClick,
  icon,
  iconBg,
  title,
  description,
  badge,
  caution,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  description: string;
  badge?: string;
  caution?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex cursor-pointer flex-col gap-4 rounded-xl border p-5 text-left transition-colors',
        'border-border hover:border-muted-foreground/40'
      )}
    >
      {/* Top row: icon + badge */}
      <div className="flex items-start justify-between">
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', iconBg)}>
          {icon}
        </div>
        {badge ? (
          <span className="rounded-full border border-emerald-700 px-2.5 py-0.5 text-[10px] font-semibold tracking-wider text-emerald-400 uppercase">
            {badge}
          </span>
        ) : null}
      </div>

      {/* Title + description */}
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-bold">{title}</p>
        <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
      </div>

      {/* Caution label */}
      {caution && (
        <div className="flex items-center gap-1.5 text-amber-400">
          <AlertCircle className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{caution}</span>
        </div>
      )}
    </button>
  );
}
