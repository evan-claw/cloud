'use client';

import { memo } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Webhook, Plus } from 'lucide-react';

type WebhookTriggersHeaderProps = {
  createUrl: string;
  disabled?: boolean;
  title?: string;
  description?: string;
  hideCreate?: boolean;
  createLabel?: string;
  badgeLabel?: string;
};

/**
 * Header component for the webhook triggers list page.
 * Shows title, beta badge, and create button.
 */
export const WebhookTriggersHeader = memo(function WebhookTriggersHeader({
  createUrl,
  disabled,
  title = 'Webhook Triggers',
  description = 'Manage webhook triggers that automatically start cloud agent sessions.',
  hideCreate = false,
  createLabel = 'Create Trigger',
  badgeLabel = 'new',
}: WebhookTriggersHeaderProps) {
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between">
        <SetPageTitle title={title}>
          <Webhook className="h-5 w-5" />
          {badgeLabel && <Badge variant="new">{badgeLabel}</Badge>}
        </SetPageTitle>
        {!hideCreate && (
          <Button asChild disabled={disabled}>
            <Link href={disabled ? '#' : createUrl}>
              <Plus className="mr-2 h-4 w-4" />
              {createLabel}
            </Link>
          </Button>
        )}
      </div>
      <p className="text-muted-foreground mt-2">{description}</p>
    </div>
  );
});
