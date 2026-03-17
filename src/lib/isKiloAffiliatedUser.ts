import { KILO_ORGANIZATION_ID } from '@/lib/organizations/constants';
import type { User } from '@kilocode/db';

export function isKiloAffiliatedUser(user: User | null, organizationId: string | null) {
  return (
    user?.google_user_email.endsWith('@kilo.ai') ||
    user?.google_user_email.endsWith('@kilocode.ai') ||
    organizationId === KILO_ORGANIZATION_ID
  );
}
