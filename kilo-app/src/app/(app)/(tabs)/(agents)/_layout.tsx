import { Stack } from 'expo-router';

import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export default function AgentsLayout() {
  const colors = useThemeColors();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Agents',
          headerRight: () => <ProfileAvatarButton />,
        }}
      />
    </Stack>
  );
}
