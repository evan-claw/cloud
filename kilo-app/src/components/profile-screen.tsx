import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { useAppContext } from '@/lib/context/context-context';
import { useTRPC } from '@/lib/trpc';

export function ProfileScreen() {
  const { signOut } = useAuth();
  const { context, clearContext } = useAppContext();
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(trpc.user.getAuthProviders.queryOptions());

  const contextLabel = context?.type === 'personal' ? 'Personal' : 'Organization';

  return (
    <View className="flex-1 gap-8 bg-background px-6 pt-16">
      <View className="items-center gap-1">
        <Text variant="muted">Context: {contextLabel}</Text>
      </View>

      {isLoading && <Text variant="muted">Loading account info...</Text>}

      {data?.providers && (
        <View className="gap-2">
          <Text variant="large">Linked accounts</Text>
          {data.providers.map(p => (
            <Text key={`${p.provider}-${p.email}`} variant="muted">
              {p.provider}: {p.email}
            </Text>
          ))}
        </View>
      )}

      <View className="gap-3">
        <Button
          variant="outline"
          onPress={() => {
            void clearContext();
          }}
        >
          <Text>Switch Context</Text>
        </Button>

        <Button
          variant="destructive"
          onPress={() => {
            void signOut();
          }}
        >
          <Text>Sign Out</Text>
        </Button>
      </View>
    </View>
  );
}
