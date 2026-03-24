import { Bug, Sparkles } from 'lucide-react-native';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import type { ChangelogEntry } from '@/lib/changelog-data';

const DEPLOY_HINT_LABELS: Record<string, string> = {
  redeploy_suggested: 'Redeploy suggested',
  redeploy_required: 'Redeploy required',
  upgrade_required: 'Upgrade required',
};

export function ChangelogList({ entries }: { entries: ChangelogEntry[] }) {
  const colors = useThemeColors();

  return (
    <View className="gap-3">
      {entries.map((entry, index) => {
        const Icon = entry.category === 'bugfix' ? Bug : Sparkles;
        const deployLabel = entry.deployHint ? DEPLOY_HINT_LABELS[entry.deployHint] : null;

        return (
          <View
            key={index}
            className="rounded-lg bg-secondary p-3 gap-2"
          >
            <View className="flex-row items-center gap-2">
              <Icon size={14} color={colors.mutedForeground} />
              <Text variant="muted" className="text-xs">
                {entry.date}
              </Text>
              {deployLabel && (
                <View className="rounded bg-muted px-1.5 py-0.5">
                  <Text className="text-xs text-muted-foreground">{deployLabel}</Text>
                </View>
              )}
            </View>
            <Text className="text-sm leading-relaxed">{entry.description}</Text>
          </View>
        );
      })}
    </View>
  );
}
