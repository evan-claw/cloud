import { useEffect, useState } from 'react';
import { Keyboard, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { SettingsCard } from '@/components/kiloclaw/settings-card';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useKiloClawChannelCatalog, useKiloClawMutations } from '@/lib/hooks/use-kiloclaw';

export default function ChannelsScreen() {
  const catalogQuery = useKiloClawChannelCatalog();
  const mutations = useKiloClawMutations();

  const isLoading = catalogQuery.isPending;
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
        </ScrollView>
      </View>
    </View>
  );
}
