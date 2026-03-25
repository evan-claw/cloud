import {
  Activity,
  Cpu,
  Globe,
  HardDrive,
  MapPin,
  MemoryStick,
  Pencil,
  RotateCcw,
  Server,
} from 'lucide-react-native';
import { type LucideIcon } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { StatusBadge } from '@/components/kiloclaw/status-badge';
import { Text } from '@/components/ui/text';
import { type useKiloClawGatewayStatus, type useKiloClawStatus } from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type InstanceStatus = NonNullable<ReturnType<typeof useKiloClawStatus>['data']>['status'];
type GatewayState = NonNullable<ReturnType<typeof useKiloClawGatewayStatus>['data']>['state'];

interface StatusCardProps {
  status: InstanceStatus | null | undefined;
  name: string | null | undefined;
  sandboxId: string | null | undefined;
  onRename?: () => void;
  region: string | null | undefined;
  cpus: number | null | undefined;
  memoryMb: number | null | undefined;
  gatewayState: GatewayState | null | undefined;
  uptime: number | null | undefined;
  restarts: number | null | undefined;
  lastExitCode: number | null | undefined;
  lastExitSignal: string | null | undefined;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h)}h ${String(m)}m`;
}

interface DetailRowProps {
  icon: LucideIcon;
  label: string;
  value: string;
}

function DetailRow({ icon: Icon, label, value }: Readonly<DetailRowProps>) {
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center gap-3 py-2">
      <Icon size={16} color={colors.mutedForeground} />
      <Text className="flex-1 text-sm text-muted-foreground">{label}</Text>
      <Text className="text-sm font-medium">{value}</Text>
    </View>
  );
}

function formatLastExit(
  exitCode: number | null | undefined,
  exitSignal: string | null | undefined
): string | undefined {
  if (exitCode === null || exitCode === undefined) {
    return exitSignal ?? undefined;
  }
  const signalPart = exitSignal ? ` (${exitSignal})` : '';
  return `Code ${String(exitCode)}${signalPart}`;
}

export function StatusCard({
  status,
  name,
  sandboxId,
  onRename,
  region,
  cpus,
  memoryMb,
  gatewayState,
  uptime,
  restarts,
  lastExitCode,
  lastExitSignal,
}: Readonly<StatusCardProps>) {
  const colors = useThemeColors();
  const memoryLabel = memoryMb ? `${(memoryMb / 1024).toFixed(0)} GB` : '—';
  const cpuLabel = cpus ? `${String(cpus)} vCPU` : '—';
  const lastExitLabel = formatLastExit(lastExitCode, lastExitSignal);

  return (
    <View className="rounded-lg bg-secondary p-4 gap-1">
      <View className="flex-row items-center justify-between pb-2">
        <Pressable
          className="flex-1 flex-row items-center gap-3 active:opacity-70"
          onPress={onRename}
          disabled={!onRename}
          accessibilityLabel="Rename instance"
        >
          <Text className="shrink text-sm font-semibold" numberOfLines={1}>
            {name ?? sandboxId ?? 'Instance'}
          </Text>
          {onRename && <Pencil size={14} color={colors.mutedForeground} />}
        </Pressable>
        <StatusBadge status={status} />
      </View>

      {region && <DetailRow icon={MapPin} label="Region" value={region} />}
      <DetailRow icon={Cpu} label="CPU" value={cpuLabel} />
      <DetailRow icon={MemoryStick} label="Memory" value={memoryLabel} />
      <DetailRow icon={HardDrive} label="Storage" value="10 GB SSD" />

      {gatewayState !== null && gatewayState !== undefined && (
        <View className="mt-2 border-t border-border pt-2 gap-1">
          <Text className="text-xs font-semibold text-muted-foreground pb-1">Gateway Process</Text>
          <DetailRow icon={Activity} label="State" value={gatewayState} />
          {uptime !== null && uptime !== undefined && (
            <DetailRow icon={Globe} label="Uptime" value={formatUptime(uptime)} />
          )}
          {restarts !== null && restarts !== undefined && (
            <DetailRow icon={RotateCcw} label="Restarts" value={String(restarts)} />
          )}
          {lastExitLabel && <DetailRow icon={Server} label="Last Exit" value={lastExitLabel} />}
        </View>
      )}
    </View>
  );
}
