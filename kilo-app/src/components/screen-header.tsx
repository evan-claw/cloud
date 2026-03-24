import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';

interface ScreenHeaderProps {
  title: string;
  headerRight?: React.ReactNode;
}

export function ScreenHeader({ title, headerRight }: Readonly<ScreenHeaderProps>) {
  const insets = useSafeAreaInsets();

  return (
    <View className="bg-background px-4 pb-3" style={{ paddingTop: insets.top + 8 }}>
      <View className="flex-row items-center justify-between">
        <Text className="text-lg font-semibold">{title}</Text>
        {headerRight}
      </View>
    </View>
  );
}
