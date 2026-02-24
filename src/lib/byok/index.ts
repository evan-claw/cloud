import type { db } from '@/lib/drizzle';
import { byok_api_keys } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { decryptApiKey } from '@/lib/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import type { UserByokProviderId } from '@/lib/providers/openrouter/inference-provider-id';

export type BYOKResult = {
  decryptedAPIKey: string;
  providerId: UserByokProviderId;
};

/**
 * Retrieves a decrypted BYOK API key for a user and provider.
 *
 * @param userId - The Kilo user ID
 * @param providerId - The provider ID (case-insensitive match)
 * @returns Object with decrypted API key and provider ID if found, null otherwise
 */
export async function getBYOKforUser(
  fromDb: typeof db,
  userId: string,
  providerId: UserByokProviderId
): Promise<BYOKResult | null> {
  const [row] = await fromDb
    .select({
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      provider_id: byok_api_keys.provider_id,
    })
    .from(byok_api_keys)
    .where(
      and(
        eq(byok_api_keys.kilo_user_id, userId),
        eq(byok_api_keys.is_enabled, true),
        sql`lower(${byok_api_keys.provider_id}) = lower(${providerId})`
      )
    );

  if (!row) {
    return null;
  }

  return {
    decryptedAPIKey: decryptApiKey(row.encrypted_api_key, BYOK_ENCRYPTION_KEY),
    providerId: row.provider_id as UserByokProviderId,
  };
}

/**
 * Retrieves a decrypted BYOK API key for an organization and provider.
 *
 * @param organizationId - The organization ID
 * @param providerId - The provider ID (case-insensitive match)
 * @returns Object with decrypted API key and provider ID if found, null otherwise
 */
export async function getBYOKforOrganization(
  fromDb: typeof db,
  organizationId: string,
  providerId: UserByokProviderId
): Promise<BYOKResult | null> {
  const [row] = await fromDb
    .select({
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      provider_id: byok_api_keys.provider_id,
    })
    .from(byok_api_keys)
    .where(
      and(
        eq(byok_api_keys.organization_id, organizationId),
        eq(byok_api_keys.is_enabled, true),
        sql`lower(${byok_api_keys.provider_id}) = lower(${providerId})`
      )
    );

  if (!row) {
    return null;
  }

  return {
    decryptedAPIKey: decryptApiKey(row.encrypted_api_key, BYOK_ENCRYPTION_KEY),
    providerId: row.provider_id as UserByokProviderId,
  };
}
