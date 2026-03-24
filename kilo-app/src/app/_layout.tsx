import '../global.css';

import { PortalHost } from '@rn-primitives/portal';
import { QueryClientProvider } from '@tanstack/react-query';
import { Slot, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Toaster } from 'sonner-native';

import { AuthProvider, useAuth } from '@/lib/auth/auth-context';
import { ContextProvider, useAppContext } from '@/lib/context/context-context';
import { queryClient } from '@/lib/query-client';
import { TRPCProvider, trpcClient } from '@/lib/trpc';

void SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
  const { token, isLoading: authLoading } = useAuth();
  const { context, isLoading: contextLoading } = useAppContext();
  const segments = useSegments();
  const router = useRouter();

  const isLoading = authLoading || contextLoading;
  const inAuthGroup = segments[0] === '(auth)';
  const inContextGroup = segments[0] === '(context)';

  useEffect(() => {
    if (isLoading) return;

    if (!token) {
      if (inAuthGroup) {
        void SplashScreen.hideAsync();
      } else {
        router.replace('/(auth)/login');
      }
    } else if (!context) {
      if (inContextGroup) {
        void SplashScreen.hideAsync();
      } else {
        router.replace('/(context)/select');
      }
    } else if (inAuthGroup || inContextGroup) {
      router.replace('/(app)');
    } else {
      void SplashScreen.hideAsync();
    }
  }, [token, context, isLoading, inAuthGroup, inContextGroup, router]);

  const needsRedirect =
    !isLoading &&
    ((!token && !inAuthGroup) ||
      (token !== undefined && !context && !inContextGroup) ||
      (token !== undefined && context !== undefined && (inAuthGroup || inContextGroup)));

  if (isLoading || needsRedirect) {
    return;
  }

  return (
    <Animated.View className="flex-1" entering={FadeIn.duration(300)}>
      <Slot />
    </Animated.View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView className="flex-1">
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ContextProvider>
              <RootLayoutNav />
              <Toaster />
              <PortalHost />
            </ContextProvider>
          </AuthProvider>
        </QueryClientProvider>
      </TRPCProvider>
    </GestureHandlerRootView>
  );
}
