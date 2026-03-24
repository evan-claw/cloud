import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

export default function ChatScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();

  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
      <Text variant="h2">Chat</Text>
      <Text variant="muted">Instance: {instanceId}</Text>
      <Text variant="muted">Coming soon</Text>
    </View>
  );
}
