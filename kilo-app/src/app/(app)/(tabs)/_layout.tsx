import * as Haptics from 'expo-haptics';
import { Tabs } from 'expo-router';
import { Bot, MessageSquare } from 'lucide-react-native';
import { toast } from 'sonner-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export const unstable_settings = {
  initialRouteName: '(kiloclaw)',
};

export default function TabsLayout() {
  const colors = useThemeColors();

  return (
    <Tabs
      initialRouteName="(kiloclaw)"
      screenOptions={{
        headerShown: false,
        freezeOnBlur: true,
        tabBarActiveTintColor: colors.foreground,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
        },
      }}
      screenListeners={{
        tabPress: () => {
          void Haptics.selectionAsync();
        },
      }}
    >
      <Tabs.Screen
        name="(kiloclaw)"
        options={{
          title: 'KiloClaw',
          tabBarIcon: ({ color, size }) => <MessageSquare size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="(agents)"
        options={{
          title: 'Agents',
          tabBarIcon: ({ color, size }) => <Bot size={size} color={color} />,
          tabBarBadge: 'Soon',
          tabBarBadgeStyle: {
            backgroundColor: colors.muted,
            color: colors.mutedForeground,
            fontSize: 9,
          },
        }}
        listeners={{
          tabPress: e => {
            e.preventDefault();
            toast('Agents is coming soon');
          },
        }}
      />
    </Tabs>
  );
}
