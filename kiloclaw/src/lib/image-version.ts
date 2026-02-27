import {
  ImageVersionEntrySchema,
  imageVersionKey,
  imageVersionLatestKey,
  IMAGE_VERSION_INDEX_KEY,
} from '../schemas/image-version';
import type { ImageVersionEntry, ImageVariant } from '../schemas/image-version';
import { upsertCatalogVersion } from './catalog-registration';

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
 * Also writes to the Postgres catalog via Hyperdrive (best-effort)
 * and maintains a KV tag index for the list endpoint.
 *
 * imageDigest is optional — the worker knows its tag but not its digest.
 */
// Throttle catalog syncs: at most once per minute per isolate.
// Cloudflare may reuse isolates across deploys, so a boolean flag alone could
// suppress legitimate syncs. A timestamp bound keeps writes rare while ensuring
// the catalog stays populated. The upsert is idempotent, so extra writes are cheap.
const CATALOG_SYNC_INTERVAL_MS = 60_000;
let lastCatalogSyncMs: number | null = null;

export async function registerVersionIfNeeded(
  kv: KVNamespace,
  openclawVersion: string,
  variant: ImageVariant,
  imageTag: string,
  imageDigest: string | null = null,
  hyperdriveConnectionString?: string
): Promise<boolean> {
  const publishedAt = new Date().toISOString();

  // Upsert to Postgres catalog, throttled to once per minute per isolate.
  const now = Date.now();
  if (
    hyperdriveConnectionString &&
    (!lastCatalogSyncMs || now - lastCatalogSyncMs > CATALOG_SYNC_INTERVAL_MS)
  ) {
    try {
      await upsertCatalogVersion(hyperdriveConnectionString, {
        openclawVersion,
        variant,
        imageTag,
        imageDigest,
        publishedAt,
      });
      lastCatalogSyncMs = now;
    } catch (e) {
      console.error(
        '[image-version] Failed to write catalog entry to Postgres:',
        e instanceof Error ? e.message : e
      );
    }
  }

  // Check if latest already matches — avoid unnecessary KV writes
  const existing = await kv.get(imageVersionLatestKey(variant), 'json');
  if (existing) {
    const parsed = ImageVersionEntrySchema.safeParse(existing);
    if (
      parsed.success &&
      parsed.data.openclawVersion === openclawVersion &&
      parsed.data.imageTag === imageTag
    ) {
      return false; // KV already current
    }
  }

  const entry: ImageVersionEntry = {
    openclawVersion,
    variant,
    imageTag,
    imageDigest,
    publishedAt,
  };

  const serialized = JSON.stringify(entry);
  await Promise.all([
    kv.put(imageVersionKey(openclawVersion, variant), serialized),
    kv.put(imageVersionLatestKey(variant), serialized),
  ]);

  // Maintain KV tag index (best-effort)
  await updateTagIndex(kv, imageTag);

  console.log('[image-version] Registered version:', openclawVersion, variant, '→', imageTag);
  return true;
}

// ---------------------------------------------------------------------------
// KV Tag Index
// ---------------------------------------------------------------------------

/**
 * Add a tag to the KV index if not already present.
 */
export async function updateTagIndex(kv: KVNamespace, imageTag: string): Promise<void> {
  try {
    const index = await getOrRebuildIndex(kv);
    if (!index.includes(imageTag)) {
      index.push(imageTag);
      await kv.put(IMAGE_VERSION_INDEX_KEY, JSON.stringify(index));
    }
  } catch (e) {
    console.warn('[image-version] Failed to update tag index:', e instanceof Error ? e.message : e);
  }
}

/**
 * Read the tag index from KV. If it's missing or corrupted, rebuild it
 * by listing all versioned KV keys.
 */
async function getOrRebuildIndex(kv: KVNamespace): Promise<string[]> {
  try {
    const raw = await kv.get(IMAGE_VERSION_INDEX_KEY, 'json');
    if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) {
      return raw;
    }
  } catch {
    // Fall through to rebuild
  }

  console.warn('[image-version] Tag index missing or corrupted, rebuilding from KV list');
  return rebuildIndex(kv);
}

/**
 * Rebuild the tag index by listing all `image-version:<ver>:<variant>` keys.
 * Excludes `image-version:latest:*` and the index key itself.
 */
async function rebuildIndex(kv: KVNamespace): Promise<string[]> {
  const tags: string[] = [];
  let cursor: string | undefined;

  // KV list is paginated (1000 keys per page)
  do {
    const result = await kv.list({ prefix: 'image-version:', cursor });
    for (const key of result.keys) {
      if (key.name.startsWith('image-version:latest:') || key.name === IMAGE_VERSION_INDEX_KEY) {
        continue;
      }
      const raw = await kv.get(key.name, 'json');
      const parsed = ImageVersionEntrySchema.safeParse(raw);
      if (parsed.success && !tags.includes(parsed.data.imageTag)) {
        tags.push(parsed.data.imageTag);
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  await kv.put(IMAGE_VERSION_INDEX_KEY, JSON.stringify(tags));
  console.log('[image-version] Rebuilt tag index with', tags.length, 'entries');
  return tags;
}

// ---------------------------------------------------------------------------
// List all versions (for admin tooling / triggerSync)
// ---------------------------------------------------------------------------

/**
 * List all registered image versions by scanning KV keys with prefix `image-version:`.
 * Paginates through all keys and parses each entry.
 */
export async function listAllVersions(kv: KVNamespace): Promise<ImageVersionEntry[]> {
  const versions: ImageVersionEntry[] = [];
  let cursor: string | undefined;

  do {
    const result = await kv.list({ prefix: 'image-version:', cursor });
    for (const key of result.keys) {
      // Skip latest pointers and the index key
      if (key.name.startsWith('image-version:latest:') || key.name === IMAGE_VERSION_INDEX_KEY) {
        continue;
      }
      const raw = await kv.get(key.name, 'json');
      const parsed = ImageVersionEntrySchema.safeParse(raw);
      if (parsed.success) {
        versions.push(parsed.data);
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return versions;
}
