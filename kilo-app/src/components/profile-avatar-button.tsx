import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Pressable } from 'react-native';

import logo from '@/../assets/images/logo.png';
import { Image } from '@/components/ui/image';
import { cn } from '@/lib/utils';

interface ProfileAvatarButtonProps {
  className?: string;
}

export function ProfileAvatarButton({ className }: Readonly<ProfileAvatarButtonProps>) {
  const router = useRouter();

  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        router.push('/(app)/profile' as never);
      }}
      className={cn('mr-2', className)}
      accessibilityRole="button"
      accessibilityLabel="Open profile"
    >
      <Image source={logo} className="h-7 w-7" transition={0} />
    </Pressable>
  );
}
