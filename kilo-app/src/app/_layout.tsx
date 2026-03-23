import '../global.css';

import { PortalHost } from '@rn-primitives/portal';
import { Slot, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Toaster } from 'sonner-native';

import { AuthProvider, useAuth } from '@/lib/auth/auth-context';
import { Text, View } from '@/tw';

function RootLayoutNav() {
  const { token, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (!token && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (token && inAuthGroup) {
      router.replace('/(app)');
    }
  }, [token, isLoading, segments, router]);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="text-4xl font-bold tracking-tight text-foreground">Kilo</Text>
      </View>
    );
  }

  return <Slot />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView className="flex-1">
      <AuthProvider>
        <RootLayoutNav />
        <Toaster />
        <PortalHost />
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
