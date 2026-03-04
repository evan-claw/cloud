// BYOK (Bring Your Own Key) utilities.
// Ported from src/lib/byok/index.ts + src/lib/byok/encryption.ts.
// Uses Web Crypto (crypto.subtle) instead of Node.js createDecipheriv.

import type { WorkerDb } from '@kilocode/db/client';
import { byok_api_keys, modelsByProvider } from '@kilocode/db/schema';
import { and, eq, inArray, desc } from 'drizzle-orm';
import * as z from 'zod';
import { mapModelIdToVercel } from './vercel-model-mapping';

// --- Types ---

type EncryptedData = {
  iv: string;
  data: string;
  authTag: string;
};

export const VercelUserByokInferenceProviderIdSchema = z.enum([
  'anthropic',
  'bedrock',
  'google',
  'openai',
  'minimax',
  'mistral',
  'xai',
  'zai',
]);

export const AutocompleteUserByokProviderIdSchema = z.enum(['codestral']);

export const UserByokProviderIdSchema = VercelUserByokInferenceProviderIdSchema.or(
  AutocompleteUserByokProviderIdSchema
);

export type UserByokProviderId = z.infer<typeof UserByokProviderIdSchema>;
export type VercelUserByokInferenceProviderId = z.infer<
  typeof VercelUserByokInferenceProviderIdSchema
>;

export type BYOKResult = {
  decryptedAPIKey: string;
  providerId: UserByokProviderId;
};

// --- Web Crypto AES-256-GCM decryption ---

async function decryptApiKey(encrypted: EncryptedData, keyBase64: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
  const ivBytes = Uint8Array.from(atob(encrypted.iv), c => c.charCodeAt(0));
  const cipherBytes = Uint8Array.from(atob(encrypted.data), c => c.charCodeAt(0));
  const tagBytes = Uint8Array.from(atob(encrypted.authTag), c => c.charCodeAt(0));

  // Web Crypto expects ciphertext + auth tag concatenated
  const cipherWithTag = new Uint8Array(cipherBytes.length + tagBytes.length);
  cipherWithTag.set(cipherBytes);
  cipherWithTag.set(tagBytes, cipherBytes.length);

  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes, tagLength: 128 },
    cryptoKey,
    cipherWithTag
  );

  return new TextDecoder().decode(decrypted);
}

function isCodestralModel(model: string): boolean {
  return model.startsWith('mistralai/codestral');
}

// --- Provider lookups ---

type StoredModelEndpoint = { tag: string };
type StoredModel = { endpoints: StoredModelEndpoint[] };

export async function getModelUserByokProviders(
  db: WorkerDb,
  model: string
): Promise<UserByokProviderId[]> {
  if (isCodestralModel(model)) return ['codestral'];

  const row = await db
    .select({ vercel: modelsByProvider.vercel })
    .from(modelsByProvider)
    .orderBy(desc(modelsByProvider.id))
    .limit(1);

  const vercelMeta = row[0]?.vercel;
  if (!vercelMeta) return [];

  const vercelModelKey = mapModelIdToVercel(model);
  const endpoints =
    (vercelMeta as Record<string, StoredModel | undefined>)[vercelModelKey]?.endpoints ?? [];

  return endpoints
    .map(ep => UserByokProviderIdSchema.safeParse(ep.tag).data)
    .filter((id): id is UserByokProviderId => id !== undefined);
}

async function decryptRow(
  row: { encrypted_api_key: EncryptedData; provider_id: string },
  encryptionKey: string
): Promise<BYOKResult> {
  return {
    decryptedAPIKey: await decryptApiKey(row.encrypted_api_key, encryptionKey),
    providerId: UserByokProviderIdSchema.parse(row.provider_id),
  };
}

export async function getBYOKforUser(
  db: WorkerDb,
  userId: string,
  providerIds: UserByokProviderId[],
  encryptionKey: string
): Promise<BYOKResult[] | null> {
  const rows = await db
    .select({
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      provider_id: byok_api_keys.provider_id,
    })
    .from(byok_api_keys)
    .where(
      and(
        eq(byok_api_keys.kilo_user_id, userId),
        eq(byok_api_keys.is_enabled, true),
        inArray(byok_api_keys.provider_id, providerIds)
      )
    )
    .orderBy(byok_api_keys.created_at);

  if (rows.length === 0) return null;
  return Promise.all(rows.map(row => decryptRow(row, encryptionKey)));
}

export async function getBYOKforOrganization(
  db: WorkerDb,
  organizationId: string,
  providerIds: UserByokProviderId[],
  encryptionKey: string
): Promise<BYOKResult[] | null> {
  const rows = await db
    .select({
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      provider_id: byok_api_keys.provider_id,
    })
    .from(byok_api_keys)
    .where(
      and(
        eq(byok_api_keys.organization_id, organizationId),
        eq(byok_api_keys.is_enabled, true),
        inArray(byok_api_keys.provider_id, providerIds)
      )
    )
    .orderBy(byok_api_keys.created_at);

  if (rows.length === 0) return null;
  return Promise.all(rows.map(row => decryptRow(row, encryptionKey)));
}
