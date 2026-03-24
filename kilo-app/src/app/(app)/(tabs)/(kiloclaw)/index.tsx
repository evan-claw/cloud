import { Server } from 'lucide-react-native';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { ScreenHeader } from '@/components/screen-header';

export default function KiloClawInstanceList() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="KiloClaw" headerRight={<ProfileAvatarButton />} />
      <View className="flex-1 items-center justify-center">
        <EmptyState
          icon={Server}
          title="No instances yet"
          description="Your KiloClaw instances will appear here"
        />
      </View>
    </View>
  );
}
