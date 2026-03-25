import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { AlertTriangle, CreditCard, Newspaper } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Alert, Linking, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { BillingBanner } from '@/components/kiloclaw/billing-banner';
import { InstanceControls } from '@/components/kiloclaw/instance-controls';
import { SettingsList } from '@/components/kiloclaw/settings-list';
import { StatusCard } from '@/components/kiloclaw/status-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useKiloClawBillingStatus,
  useKiloClawGatewayStatus,
  useKiloClawMutations,
  useKiloClawServiceDegraded,
  useKiloClawStatus,
} from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export default function DashboardScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();

  const statusQuery = useKiloClawStatus();
  const billingQuery = useKiloClawBillingStatus();
  const serviceDegradedQuery = useKiloClawServiceDegraded();
  const mutations = useKiloClawMutations();

  const status = statusQuery.data;
  const isRunning = status?.status === 'running';

  const gatewayQuery = useKiloClawGatewayStatus(isRunning);
  const gateway = gatewayQuery.data;

  const billing = billingQuery.data;
  const isServiceDegraded = serviceDegradedQuery.data === true;
  const isLoading = statusQuery.isPending || billingQuery.isPending;

  const [renameVisible, setRenameVisible] = useState(false);
  const renameRef = useRef('');

  const handleRename = () => {
    renameRef.current = status?.name ?? '';
    setRenameVisible(true);
  };

  const submitRename = () => {
    const trimmed = renameRef.current.trim();
    if (trimmed) {
      mutations.renameInstance.mutate({ name: trimmed });
    }
    setRenameVisible(false);
  };

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Dashboard" />
        <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4 gap-3">
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-40 w-full rounded-lg" />
          </Animated.View>
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-10 w-full rounded-lg" />
          </Animated.View>
        </Animated.View>
      </View>
    );
  }

  if (statusQuery.isError || billingQuery.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Dashboard" />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message="Could not load dashboard"
            onRetry={() => {
              void statusQuery.refetch();
              void billingQuery.refetch();
            }}
          />
        </View>
      </View>
    );
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title="Dashboard" />
      <ScrollView contentContainerClassName="gap-4 px-4 py-4" showsVerticalScrollIndicator={false}>
        <Animated.View entering={FadeIn.duration(200)} className="gap-4">
          {isServiceDegraded && (
            <Pressable
              className="flex-row items-center gap-3 rounded-lg bg-red-100 dark:bg-red-950 p-3 active:opacity-70"
              onPress={() => {
                void Linking.openURL('https://status.kilo.ai');
              }}
            >
              <AlertTriangle size={18} color={colors.foreground} />
              <Text className="flex-1 text-xs font-medium">
                Service degraded — tap to view status
              </Text>
            </Pressable>
          )}

          {billing && <BillingBanner billing={billing} />}

          <StatusCard
            status={status?.status}
            name={status?.name}
            sandboxId={status?.sandboxId}
            onRename={handleRename}
            region={status?.flyRegion}
            cpus={status?.machineSize?.cpus}
            memoryMb={status?.machineSize?.memory_mb}
            gatewayState={gateway?.state}
            uptime={gateway?.uptime}
            restarts={gateway?.restarts}
            lastExitCode={gateway?.lastExit?.code}
            lastExitSignal={gateway?.lastExit?.signal}
            gatewayLoading={isRunning && gatewayQuery.isPending}
          />

          <InstanceControls status={status?.status} mutations={mutations} />

          <SettingsList />

          <View className="rounded-lg bg-secondary overflow-hidden">
            <Text className="px-4 pt-3 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              More
            </Text>
            <Pressable
              className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
              onPress={() => {
                router.push(`/(app)/(tabs)/(1_kiloclaw)/${instanceId}/billing` as Href);
              }}
            >
              <CreditCard size={18} color="#10b981" />
              <Text className="flex-1 text-sm font-medium">Billing</Text>
            </Pressable>
            <View className="ml-14 h-px bg-border" />
            <Pressable
              className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
              onPress={() => {
                router.push(`/(app)/(tabs)/(1_kiloclaw)/${instanceId}/changelog` as Href);
              }}
            >
              <Newspaper size={18} color="#3b82f6" />
              <Text className="flex-1 text-sm font-medium">{"What's New"}</Text>
            </Pressable>
          </View>
        </Animated.View>
      </ScrollView>

      <Modal visible={renameVisible} transparent animationType="fade">
        <Pressable className="flex-1 justify-center bg-black/50 px-6" onPress={() => setRenameVisible(false)}>
          <Pressable className="rounded-xl bg-card p-5 gap-4" onPress={e => e.stopPropagation()}>
            <Text className="text-base font-semibold">Rename Instance</Text>
            <TextInput
              className="rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground"
              placeholder="Enter a new name (max 50 characters)"
              placeholderTextColor={colors.mutedForeground}
              defaultValue={status?.name ?? ''}
              onChangeText={val => {
                renameRef.current = val;
              }}
              autoFocus
              maxLength={50}
            />
            <View className="flex-row justify-end gap-3">
              <Button variant="outline" onPress={() => setRenameVisible(false)}>
                <Text>Cancel</Text>
              </Button>
              <Button onPress={submitRename}>
                <Text className="text-primary-foreground">Save</Text>
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Animated.View>
  );
}
