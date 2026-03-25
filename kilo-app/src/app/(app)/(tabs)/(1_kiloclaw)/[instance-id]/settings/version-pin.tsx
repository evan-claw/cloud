import { Check } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, FlatList, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useControllerVersion,
  useKiloClawAvailableVersions,
  useKiloClawLatestVersion,
  useKiloClawMutations,
  useKiloClawMyPin,
} from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type VersionItem = NonNullable<
  ReturnType<typeof useKiloClawAvailableVersions>['data']
>['items'][number];

export default function VersionPinScreen() {
  const colors = useThemeColors();
  const myPinQuery = useKiloClawMyPin();
  const controllerQuery = useControllerVersion(true);
  const latestVersionQuery = useKiloClawLatestVersion();
  const availableVersionsQuery = useKiloClawAvailableVersions();
  const mutations = useKiloClawMutations();
  const [pendingReason, setPendingReason] = useState('');
  const [pendingItem, setPendingItem] = useState<VersionItem>();

  const isLoading =
    myPinQuery.isPending || controllerQuery.isPending || latestVersionQuery.isPending;

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Version Pinning" />
        <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4 gap-3">
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-16 w-full rounded-lg" />
          </Animated.View>
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-12 w-full rounded-lg" />
          </Animated.View>
        </Animated.View>
      </View>
    );
  }

  const myPin = myPinQuery.data;
  const controllerVersion = controllerQuery.data;
  const latestVersion = latestVersionQuery.data;
  const versions = availableVersionsQuery.data?.items ?? [];

  const isPinnedByAdmin =
    myPin !== null && myPin !== undefined && myPin.pinned_by !== myPin.user_id;

  function handleUnpin() {
    Alert.alert('Unpin Version', 'Switch back to the latest available version?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unpin',
        style: 'destructive',
        onPress: () => {
          mutations.removeMyPin.mutate();
        },
      },
    ]);
  }

  function handlePin(item: VersionItem) {
    setPendingItem(item);
    setPendingReason('');
  }

  function confirmPin() {
    if (!pendingItem) return;
    const reason = pendingReason.trim() || undefined;
    mutations.setMyPin.mutate(
      { imageTag: pendingItem.image_tag, reason },
      {
        onSuccess: () => {
          setPendingItem(undefined);
          setPendingReason('');
        },
      }
    );
  }

  function cancelPin() {
    setPendingItem(undefined);
    setPendingReason('');
  }

  function renderVersionItem({ item }: { item: VersionItem }) {
    const isPinned = myPin?.image_tag === item.image_tag;
    const dateStr = item.published_at
      ? new Date(item.published_at).toLocaleDateString()
      : undefined;
    const isPending = pendingItem?.image_tag === item.image_tag;

    return (
      <View>
        <View className="flex-row items-center gap-3 px-4 py-3">
          <View className="flex-1 gap-0.5">
            <Text className="text-sm font-medium">{item.openclaw_version}</Text>
            {Boolean(dateStr ?? item.variant) && (
              <Text variant="muted" className="text-xs">
                {[dateStr, item.variant].filter(Boolean).join(' · ')}
              </Text>
            )}
          </View>
          {isPinned ? (
            <Check size={18} color={colors.foreground} />
          ) : (
            <Button
              size="sm"
              variant={isPending ? 'default' : 'outline'}
              onPress={() => {
                if (isPending) {
                  cancelPin();
                } else {
                  handlePin(item);
                }
              }}
            >
              <Text>{isPending ? 'Cancel' : 'Pin'}</Text>
            </Button>
          )}
        </View>
        {isPending && (
          <Animated.View entering={FadeIn.duration(150)} className="border-t border-border">
            <View className="px-4 py-3 gap-3">
              <Text className="text-xs font-medium text-muted-foreground">Reason (optional)</Text>
              <TextInput
                className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                placeholder="Why are you pinning this version?"
                placeholderTextColor={colors.mutedForeground}
                value={pendingReason}
                onChangeText={val => {
                  if (val.length <= 500) setPendingReason(val);
                }}
                autoCapitalize="sentences"
                autoCorrect
                multiline
                maxLength={500}
              />
              <Button size="sm" disabled={mutations.setMyPin.isPending} onPress={confirmPin}>
                <Check size={14} color={colors.primaryForeground} />
                <Text className="text-xs text-primary-foreground">Confirm Pin</Text>
              </Button>
            </View>
          </Animated.View>
        )}
      </View>
    );
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title="Version Pinning" />
      <FlatList
        data={versions}
        keyExtractor={item => item.image_tag}
        renderItem={renderVersionItem}
        contentContainerClassName="px-4 py-4 gap-4"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <Animated.View entering={FadeIn.duration(200)} className="gap-4 mb-2">
            <View className="rounded-lg bg-secondary p-4 gap-3">
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Current Version
              </Text>
              {controllerVersion ? (
                <View className="gap-1">
                  <Text className="text-sm font-medium">
                    {controllerVersion.version ?? 'Unknown'}
                  </Text>
                  {controllerVersion.openclawVersion && (
                    <Text variant="muted" className="text-xs">
                      OpenClaw: {controllerVersion.openclawVersion}
                    </Text>
                  )}
                </View>
              ) : (
                <Text variant="muted" className="text-sm">
                  Version info unavailable
                </Text>
              )}

              <View className="flex-row items-center justify-between">
                <View className="flex-1 gap-0.5">
                  <Text variant="muted" className="text-xs">
                    {myPin
                      ? `Pinned to ${myPin.openclaw_version ?? myPin.image_tag}`
                      : 'Using latest'}
                  </Text>
                  {myPin?.reason && (
                    <Text variant="muted" className="text-xs">
                      Reason: {myPin.reason}
                    </Text>
                  )}
                  {isPinnedByAdmin && (
                    <Text className="text-xs text-amber-600 dark:text-amber-400">
                      Pinned by admin — contact your admin to change or remove it.
                    </Text>
                  )}
                </View>
                {myPin && !isPinnedByAdmin && (
                  <Button size="sm" variant="outline" onPress={handleUnpin}>
                    <Text>Unpin</Text>
                  </Button>
                )}
              </View>

              {latestVersion && (
                <Text variant="muted" className="text-xs">
                  Latest available: {latestVersion.openclawVersion}
                </Text>
              )}
            </View>

            {versions.length > 0 && (
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Available Versions
              </Text>
            )}
          </Animated.View>
        }
        ItemSeparatorComponent={() => <View className="h-px bg-border mx-4" />}
        ListEmptyComponent={
          availableVersionsQuery.isPending ? (
            <Skeleton className="h-12 w-full rounded-lg" />
          ) : undefined
        }
        className="rounded-lg bg-secondary"
      />
    </Animated.View>
  );
}
