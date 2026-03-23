import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { View } from '@/tw';

function getNameFromToken(token: string): string | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(atob(payload)) as { name?: string };
    return decoded.name;
  } catch {
    return undefined;
  }
}

export default function HomeScreen() {
  const { token, signOut } = useAuth();
  const name = token ? getNameFromToken(token) : undefined;

  return (
    <View className="flex-1 items-center justify-center gap-6 bg-background px-6">
      <Text variant="h1">{name ? `${name}, welcome to Kilo!` : 'Welcome to Kilo!'}</Text>
      <Button
        variant="outline"
        onPress={() => {
          void signOut();
        }}
      >
        <Text>Sign Out</Text>
      </Button>
    </View>
  );
}
