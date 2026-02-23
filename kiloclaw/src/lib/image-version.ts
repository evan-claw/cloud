import {
  ImageVersionEntrySchema,
  imageVersionKey,
  imageVersionLatestKey,
  type ImageVariant,
} from '../schemas/image-version';
import type { ImageVersionEntry } from '../schemas/image-version';

/**
 * Read `image-version:latest:<variant>` from KV.
 * Returns the full parsed ImageVersionEntry or null (single KV read).
 * Callers destructure what they need.
 */
export async function resolveLatestVersion(
  kv: KVNamespace,
  variant: ImageVariant
): Promise<ImageVersionEntry | null> {
  const raw = await kv.get(imageVersionLatestKey(variant), 'json');
  if (!raw) return null;

  const parsed = ImageVersionEntrySchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[image-version] Invalid latest entry in KV:', parsed.error.flatten());
    return null;
  }

  return parsed.data;
}

/**
 * Register a version in KV if the latest entry doesn't already match.
 * Writes both the versioned key and the latest pointer. Idempotent —
 * safe to call on every request (no-ops if already current).
 *
 * Rejects registration if the digest already belongs to a different tag
 * (same image must not have two catalog entries).
 *
 * imageDigest is optional — the worker knows its tag but not its digest
 * unless FLY_IMAGE_DIGEST is set.
 */
export async function registerVersionIfNeeded(
  kv: KVNamespace,
  openclawVersion: string,
  variant: ImageVariant,
  imageTag: string,
  imageDigest: string | null = null
): Promise<boolean> {
  // Check if latest already matches — avoid unnecessary writes
  const existing = await kv.get(imageVersionLatestKey(variant), 'json');
  if (existing) {
    const parsed = ImageVersionEntrySchema.safeParse(existing);
    if (parsed.success) {
      if (parsed.data.openclawVersion === openclawVersion && parsed.data.imageTag === imageTag) {
        return false; // already current
      }

      // Reject if a different tag already has this digest
      if (
        imageDigest &&
        parsed.data.imageDigest === imageDigest &&
        parsed.data.imageTag !== imageTag
      ) {
        console.warn(
          `[image-version] Rejected registration: digest ${imageDigest.slice(0, 16)}... already belongs to tag "${parsed.data.imageTag}", refusing to register under "${imageTag}"`
        );
        return false;
      }
    }
  }

  // Also check the versioned key for the same version+variant — another tag
  // may have registered this version with the same digest under a different tag.
  if (imageDigest) {
    const versionedRaw = await kv.get(imageVersionKey(openclawVersion, variant), 'json');
    if (versionedRaw) {
      const parsed = ImageVersionEntrySchema.safeParse(versionedRaw);
      if (
        parsed.success &&
        parsed.data.imageDigest === imageDigest &&
        parsed.data.imageTag !== imageTag
      ) {
        console.warn(
          `[image-version] Rejected registration: digest ${imageDigest.slice(0, 16)}... already belongs to tag "${parsed.data.imageTag}" at version ${openclawVersion}:${variant}, refusing "${imageTag}"`
        );
        return false;
      }
    }
  }

  const entry: ImageVersionEntry = {
    openclawVersion,
    variant,
    imageTag,
    imageDigest,
    publishedAt: new Date().toISOString(),
  };

  const serialized = JSON.stringify(entry);
  await Promise.all([
    kv.put(imageVersionKey(openclawVersion, variant), serialized),
    kv.put(imageVersionLatestKey(variant), serialized),
  ]);

  console.log('[image-version] Registered version:', openclawVersion, variant, '→', imageTag);
  return true;
}

/**
 * Look up a specific version entry from KV by version + variant.
 * Used by the publish flow — NOT by pinning (pinning passes tag directly).
 */
export async function lookupVersion(
  kv: KVNamespace,
  version: string,
  variant: ImageVariant
): Promise<ImageVersionEntry | null> {
  const raw = await kv.get(imageVersionKey(version, variant), 'json');
  if (!raw) return null;

  const parsed = ImageVersionEntrySchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      '[image-version] Invalid entry in KV for',
      version,
      variant,
      parsed.error.flatten()
    );
    return null;
  }

  return parsed.data;
}
