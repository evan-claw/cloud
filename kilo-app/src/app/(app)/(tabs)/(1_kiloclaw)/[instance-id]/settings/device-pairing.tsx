import { Monitor } from 'lucide-react-native';
import { Alert, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useKiloClawDevicePairing, useKiloClawMutations } from '@/lib/hooks/use-kiloclaw';

export default function DevicePairingScreen() {
  const colors = useThemeColors();
  const pairingQuery = useKiloClawDevicePairing();
  const mutations = useKiloClawMutations();

  if (pairingQuery.isPending) {
    return (
      <Animated.View layout={LinearTransition} className="flex-1 bg-background px-4 pt-4 gap-3">
        <Animated.View exiting={FadeOut.duration(150)}>
          <Skeleton className="h-16 w-full rounded-lg" />
        </Animated.View>
      </Animated.View>
    );
  }

  const requests = pairingQuery.data?.requests ?? [];

  if (requests.length === 0) {
    return (
      <Animated.View
        entering={FadeIn.duration(200)}
        className="flex-1 bg-background items-center justify-center"
      >
        <EmptyState
          icon={Monitor}
          title="No pairing requests"
          description="Device pairing requests will appear here."
        />
      </Animated.View>
    );
  }

  function handleApprove(requestId: string, platform?: string) {
    const label = platform ?? 'Unknown device';
    Alert.alert('Approve Device', `Allow ${label} to connect to your instance?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Approve',
        onPress: () => {
          mutations.approveDevicePairingRequest.mutate({ requestId });
        },
      },
    ]);
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="px-4 py-4 gap-4"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View entering={FadeIn.duration(200)}>
          <View className="rounded-lg bg-secondary overflow-hidden">
            {requests.map((request, index) => (
              <View key={request.requestId}>
                {index > 0 && <View className="ml-4 h-px bg-border" />}
                <View className="flex-row items-center gap-3 px-4 py-3">
                  <Monitor size={18} color={colors.foreground} />
                  <View className="flex-1 gap-0.5">
                    <Text className="text-sm font-medium">
                      {request.platform ?? 'Unknown device'}
                    </Text>
                    {request.role && (
                      <Text variant="muted" className="text-xs">
                        Role: {request.role}
                      </Text>
                    )}
                  </View>
                  <Button
                    size="sm"
                    onPress={() => {
                      handleApprove(request.requestId, request.platform);
                    }}
                  >
                    <Text>Approve</Text>
                  </Button>
                </View>
              </View>
            ))}
          </View>
        </Animated.View>
      </ScrollView>
    </Animated.View>
  );
}
