import { useFeatureFlagEnabled } from 'posthog-js/react';
import { useUser } from './useUser';
import { GASTOWN_MANUAL_USER_IDS } from '@/lib/gastown/manual-access';

const GASTOWN_ACCESS_FLAG = 'gastown-access';

export function useGastownEnabled() {
  const { data: user } = useUser();
  const flagEnabled = useFeatureFlagEnabled(GASTOWN_ACCESS_FLAG);
  const isManuallyEnabled = user ? GASTOWN_MANUAL_USER_IDS.has(user.id) : false;
  return isManuallyEnabled || flagEnabled;
}
