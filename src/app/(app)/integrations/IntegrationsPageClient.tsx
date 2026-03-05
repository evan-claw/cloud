'use client';

import { IntegrationsHub } from '@/components/integrations/IntegrationsHub';
import { PageContainer } from '@/components/layouts/PageContainer';

export function IntegrationsPageClient() {
  return (
    <PageContainer>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-100">Integrations</h1>
        <p className="text-muted-foreground mt-2">
          Connect your development tools and workflows with Kilocode
        </p>
      </div>
      <IntegrationsHub />
    </PageContainer>
  );
}
