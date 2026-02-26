'use client';

import { useRouter } from 'next/navigation';
import { PlatformCard } from './components/PlatformCard';
import {
  buildPlatformsForOrg,
  PLATFORM_DEFINITIONS,
} from '@/lib/integrations/platform-definitions';
import { Card, CardContent } from '@/components/ui/card';
import { OrgGitHubAppsProvider } from '@/components/integrations/OrgGitHubAppsProvider';
import { useGitHubAppsInstallation } from '@/components/integrations/GitHubAppsContext';
import { OrgSlackProvider } from '@/components/integrations/OrgSlackProvider';
import { useSlackInstallation } from '@/components/integrations/SlackContext';
import { OrgDiscordProvider } from '@/components/integrations/OrgDiscordProvider';
import { useDiscordInstallation } from '@/components/integrations/DiscordContext';
import { OrgGitLabProvider } from '@/components/integrations/OrgGitLabProvider';
import { useGitLabInstallation } from '@/components/integrations/GitLabContext';

type IntegrationsPageClientProps = {
  organizationId: string;
};

function IntegrationsPageContent({ organizationId }: IntegrationsPageClientProps) {
  const router = useRouter();
  const { data: githubInstallation, isLoading: githubLoading } = useGitHubAppsInstallation();
  const { data: slackInstallation, isLoading: slackLoading } = useSlackInstallation();
  const { data: discordInstallation, isLoading: discordLoading } = useDiscordInstallation();
  const { data: gitlabInstallation, isLoading: gitlabLoading } = useGitLabInstallation();

  const isLoading = githubLoading || slackLoading || discordLoading || gitlabLoading;

  if (isLoading) {
    return (
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {PLATFORM_DEFINITIONS.map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-6">
              <div className="animate-pulse space-y-4">
                <div className="bg-muted h-20 rounded" />
                <div className="bg-muted h-12 rounded" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const platforms = buildPlatformsForOrg(organizationId, {
    github: githubInstallation,
    slack: slackInstallation,
    discord: discordInstallation,
    gitlab: gitlabInstallation,
  });

  const handleNavigate = (platformId: string) => {
    const platform = platforms.find(p => p.id === platformId);
    if (platform?.route) {
      router.push(platform.route);
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {platforms.map(platform => (
        <PlatformCard key={platform.id} platform={platform} onNavigate={handleNavigate} />
      ))}
    </div>
  );
}

export function IntegrationsPageClient({ organizationId }: IntegrationsPageClientProps) {
  return (
    <OrgGitHubAppsProvider organizationId={organizationId}>
      <OrgSlackProvider organizationId={organizationId}>
        <OrgDiscordProvider organizationId={organizationId}>
          <OrgGitLabProvider organizationId={organizationId}>
            <IntegrationsPageContent organizationId={organizationId} />
          </OrgGitLabProvider>
        </OrgDiscordProvider>
      </OrgSlackProvider>
    </OrgGitHubAppsProvider>
  );
}
