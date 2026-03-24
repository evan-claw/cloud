import { ExternalLink } from 'lucide-react-native';
import { Linking, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { AccessLockedScreen } from '@/components/kiloclaw/access-locked-screen';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  deriveLockReason,
  formatBillingDate,
} from '@/lib/hooks/use-kiloclaw-billing';
import { useKiloClawBillingStatus } from '@/lib/hooks/use-kiloclaw';

export default function BillingScreen() {
  const colors = useThemeColors();
  const billingQuery = useKiloClawBillingStatus();
  const billing = billingQuery.data;

  if (billingQuery.isPending) {
    return (
      <Animated.View layout={LinearTransition} className="flex-1 bg-background px-4 pt-4 gap-3">
        <Animated.View exiting={FadeOut.duration(150)}>
          <Skeleton className="h-24 w-full rounded-lg" />
        </Animated.View>
      </Animated.View>
    );
  }

  if (!billing) {
    return null;
  }

  const lockReason = deriveLockReason(billing);

  if (lockReason !== null) {
    return <AccessLockedScreen reason={lockReason} />;
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="gap-4 px-4 py-4"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View entering={FadeIn.duration(200)} className="gap-4">
          {/* Current Plan card */}
          <View className="bg-secondary p-4 rounded-lg gap-2">
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Current Plan
            </Text>
            {billing.subscription ? (
              <View className="gap-1">
                <Text className="text-base font-semibold">
                  {billing.subscription.plan.charAt(0).toUpperCase() +
                    billing.subscription.plan.slice(1)}
                </Text>
                <Text variant="muted" className="text-sm">
                  Status:{' '}
                  {billing.subscription.status.charAt(0).toUpperCase() +
                    billing.subscription.status.slice(1)}
                </Text>
                <Text variant="muted" className="text-sm">
                  Current period ends: {formatBillingDate(billing.subscription.currentPeriodEnd)}
                </Text>
                {billing.subscription.cancelAtPeriodEnd && (
                  <Text className="text-sm text-destructive">
                    Cancels at end of billing period
                  </Text>
                )}
              </View>
            ) : billing.trial && !billing.trial.expired ? (
              <View className="gap-1">
                <Text className="text-base font-semibold">Free Trial</Text>
                <Text variant="muted" className="text-sm">
                  {billing.trial.daysRemaining} day
                  {billing.trial.daysRemaining === 1 ? '' : 's'} remaining
                </Text>
                <Text variant="muted" className="text-sm">
                  Ends: {formatBillingDate(billing.trial.endsAt)}
                </Text>
              </View>
            ) : billing.earlybird ? (
              <View className="gap-1">
                <Text className="text-base font-semibold">Earlybird</Text>
                <Text variant="muted" className="text-sm">
                  {billing.earlybird.daysRemaining} day
                  {billing.earlybird.daysRemaining === 1 ? '' : 's'} remaining
                </Text>
                <Text variant="muted" className="text-sm">
                  Expires: {formatBillingDate(billing.earlybird.expiresAt)}
                </Text>
              </View>
            ) : (
              <Text variant="muted" className="text-sm">
                No active plan
              </Text>
            )}
          </View>

          {/* Access card */}
          <View className="bg-secondary p-4 rounded-lg gap-2">
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Access
            </Text>
            <View className="gap-1">
              <Text className="text-sm">
                {billing.hasAccess ? 'Access granted' : 'No access'}
              </Text>
              {billing.accessReason && (
                <Text variant="muted" className="text-sm">
                  Reason:{' '}
                  {billing.accessReason.charAt(0).toUpperCase() + billing.accessReason.slice(1)}
                </Text>
              )}
            </View>
          </View>

          {/* Manage billing button */}
          <Button
            variant="outline"
            onPress={() => {
              void Linking.openURL('https://kilo.ai/claw');
            }}
            className="flex-row gap-2"
          >
            <ExternalLink size={16} color={colors.foreground} />
            <Text className="font-medium">Manage Billing on Web</Text>
          </Button>
        </Animated.View>
      </ScrollView>
    </Animated.View>
  );
}
