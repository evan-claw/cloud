import { Link, MessageSquare } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, Keyboard, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { SettingsCard } from '@/components/kiloclaw/settings-card';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useKiloClawChannelCatalog,
  useKiloClawMutations,
  useKiloClawPairing,
} from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  github: 'GitHub',
};

export default function ChannelsScreen() {
  const colors = useThemeColors();
  const catalogQuery = useKiloClawChannelCatalog();
  const pairingQuery = useKiloClawPairing();
  const mutations = useKiloClawMutations();

  const isLoading = catalogQuery.isPending;
  const pairingRequests = pairingQuery.data?.requests ?? [];
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardWillShow', e => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardWillHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  function handleApprove(channel: string, code: string) {
    const label = CHANNEL_LABELS[channel] ?? channel;
    Alert.alert(
      'Approve Pairing Request',
      `Allow ${label} (code: ${code}) to connect to your instance?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          onPress: () => {
            mutations.approvePairingRequest.mutate({ channel, code });
          },
        },
      ]
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Channels" />
      <View className="flex-1">
        <ScrollView
          contentContainerClassName="py-4 gap-4"
          contentInset={{ bottom: keyboardHeight > 0 ? keyboardHeight + 10 : 0 }}
          scrollIndicatorInsets={{ bottom: keyboardHeight > 0 ? keyboardHeight + 10 : 0 }}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          {isLoading ? (
            <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-4">
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
            </Animated.View>
          ) : (
            <Animated.View entering={FadeIn.duration(200)} className="gap-3">
              {catalogQuery.data?.map(channel => (
                <SettingsCard
                  key={channel.id}
                  item={channel}
                  mutations={mutations}
                  removeAlertTitle="Disconnect Channel"
                  removeAlertMessage={`Remove ${channel.label}? This channel will be disconnected.`}
                  successMessage={`${channel.label} connected`}
                />
              ))}
            </Animated.View>
          )}

          {/* Pairing requests */}
          <View className="gap-3 px-4">
            <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Pending Pairing Requests
            </Text>
            {pairingRequests.length > 0 ? (
              <View className="overflow-hidden rounded-lg bg-secondary">
                {pairingRequests.map((request, index) => (
                  <View key={`${request.channel}-${request.code}`}>
                    {index > 0 && <View className="ml-4 h-px bg-border" />}
                    <View className="flex-row items-center gap-3 px-4 py-3">
                      <MessageSquare size={18} color={colors.foreground} />
                      <View className="flex-1 gap-0.5">
                        <Text className="text-sm font-medium">
                          {CHANNEL_LABELS[request.channel] ?? request.channel}
                        </Text>
                        <Text variant="muted" className="text-xs">
                          Code: {request.code}
                        </Text>
                      </View>
                      <Button
                        size="sm"
                        onPress={() => {
                          handleApprove(request.channel, request.code);
                        }}
                      >
                        <Text>Approve</Text>
                      </Button>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState
                icon={Link}
                title="No Pairing Requests"
                description="Pairing requests from channels will appear here for approval."
                className="py-8"
              />
            )}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}
