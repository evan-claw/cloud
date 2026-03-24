import { useRouter } from 'expo-router';
import { MessageSquare, Server } from 'lucide-react-native';
import { Linking, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { InstanceRow } from '@/components/kiloclaw/instance-row';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAppContext } from '@/lib/context/context-context';
import { useKiloClawBillingStatus, useKiloClawStatus } from '@/lib/hooks/use-kiloclaw';
import { deriveLockReason } from '@/lib/hooks/use-kiloclaw-billing';

export default function KiloClawInstanceList() {
  const router = useRouter();
  const { context, clearContext } = useAppContext();
  const isPersonal = context?.type === 'personal' || context === undefined;

  const statusQuery = useKiloClawStatus(isPersonal);
  const billingQuery = useKiloClawBillingStatus(isPersonal);

  const status = statusQuery.data;
  const billing = billingQuery.data;
  const lockReason = billing ? deriveLockReason(billing) : null;

  const isLoading = isPersonal && (statusQuery.isPending || billingQuery.isPending);

  const instanceId = status?.sandboxId ?? 'default';
  const billingPath = `/(app)/(tabs)/(1_kiloclaw)/${instanceId}/billing` as const;
  const chatPath = `/(app)/(tabs)/(1_kiloclaw)/${instanceId}` as const;
  const dashboardPath = `/(app)/(tabs)/(1_kiloclaw)/${instanceId}/dashboard` as const;

  const handlePress = () => {
    if (lockReason) {
      router.push(billingPath);
    } else {
      router.push(chatPath);
    }
  };

  const handleSettingsPress = () => {
    if (lockReason) {
      router.push(billingPath);
    } else {
      router.push(dashboardPath);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="KiloClaw" headerRight={<ProfileAvatarButton />} />
      <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4">
        {!isPersonal ? (
          <Animated.View entering={FadeIn.duration(200)} className="flex-1 items-center justify-center">
            <EmptyState
              icon={Server}
              title="Not available for organizations"
              description="KiloClaw is only available for personal accounts."
              action={
                <Button
                  variant="outline"
                  onPress={() => {
                    void clearContext();
                  }}
                >
                  <Text>Switch to Personal</Text>
                </Button>
              }
            />
          </Animated.View>
        ) : isLoading ? (
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-16 w-full rounded-lg" />
          </Animated.View>
        ) : status?.status === null || status === undefined ? (
          <Animated.View entering={FadeIn.duration(200)} className="flex-1 items-center justify-center">
            <EmptyState
              icon={Server}
              title="No KiloClaw instances"
              description="You don't have any KiloClaw instances yet."
              action={
                <Button
                  variant="outline"
                  onPress={() => {
                    void Linking.openURL('https://kilo.ai/claw');
                  }}
                >
                  <Text>Create on Web</Text>
                </Button>
              }
            />
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn.duration(200)}>
            <InstanceRow
              sandboxId={status.sandboxId ?? null}
              status={status.status}
              region={status.flyRegion ?? null}
              cpus={status.machineSize?.cpus ?? null}
              memoryMb={status.machineSize?.memory_mb ?? null}
              onPress={handlePress}
              onSettingsPress={handleSettingsPress}
            />
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}
