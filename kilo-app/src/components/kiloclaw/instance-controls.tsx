import { Play, Power, RefreshCw, RotateCcw } from 'lucide-react-native';
import { Alert, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import type { useKiloClawMutations } from '@/lib/hooks/use-kiloclaw';

type InstanceControlsProps = {
  status: string | null;
  mutations: ReturnType<typeof useKiloClawMutations>;
};

export function InstanceControls({ status, mutations }: InstanceControlsProps) {
  const colors = useThemeColors();

  const canStart = status === 'stopped' || status === 'provisioned';
  const canStop = status === 'running';
  const canRestartOpenClaw = status === 'running';
  const canRedeploy = status === 'running' || status === 'stopped' || status === 'provisioned';

  const handleStart = () => {
    Alert.alert('Start Instance', 'Are you sure you want to start this instance?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Start',
        onPress: () => {
          mutations.start.mutate(undefined);
        },
      },
    ]);
  };

  const handleStop = () => {
    Alert.alert('Stop Instance', 'Are you sure you want to stop this instance?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop',
        style: 'destructive',
        onPress: () => {
          mutations.stop.mutate(undefined);
        },
      },
    ]);
  };

  const handleRestartOpenClaw = () => {
    Alert.alert('Restart OpenClaw', 'Are you sure you want to restart the OpenClaw process?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restart',
        onPress: () => {
          mutations.restartOpenClaw.mutate(undefined);
        },
      },
    ]);
  };

  const handleRedeploy = () => {
    Alert.alert('Redeploy Instance', 'Are you sure you want to redeploy this instance?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Redeploy',
        onPress: () => {
          mutations.restartMachine.mutate(undefined);
        },
      },
    ]);
  };

  return (
    <View className="flex-row flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={!canStart || mutations.start.isPending}
        onPress={handleStart}
      >
        <Play size={14} color={colors.foreground} />
        <Text>{mutations.start.isPending ? 'Starting...' : 'Start'}</Text>
      </Button>

      <Button
        variant="outline"
        size="sm"
        disabled={!canStop || mutations.stop.isPending}
        onPress={handleStop}
      >
        <Power size={14} color={colors.foreground} />
        <Text>{mutations.stop.isPending ? 'Stopping...' : 'Stop'}</Text>
      </Button>

      <Button
        variant="outline"
        size="sm"
        disabled={!canRestartOpenClaw || mutations.restartOpenClaw.isPending}
        onPress={handleRestartOpenClaw}
      >
        <RotateCcw size={14} color={colors.foreground} />
        <Text>{mutations.restartOpenClaw.isPending ? 'Restarting...' : 'Restart OpenClaw'}</Text>
      </Button>

      <Button
        variant="outline"
        size="sm"
        disabled={!canRedeploy || mutations.restartMachine.isPending}
        onPress={handleRedeploy}
      >
        <RefreshCw size={14} color={colors.foreground} />
        <Text>{mutations.restartMachine.isPending ? 'Redeploying...' : 'Redeploy'}</Text>
      </Button>
    </View>
  );
}
