import type { IngestBatch } from '../types/session-sync';
import { byteLengthUtf8, MAX_DO_INGEST_CHUNK_BYTES, MAX_INGEST_ITEM_BYTES } from './ingest-limits';
import { stripIngestBloat } from './strip-ingest-bloat';

export type SplitIngestBatchForDOResult = {
  chunks: IngestBatch[];
  droppedOversizeItems: number;
};

export function splitIngestBatchForDO(items: IngestBatch): SplitIngestBatchForDOResult {
  const chunks: IngestBatch[] = [];
  let currentChunk: IngestBatch = [];

  // Approximate serialized list size; this is intentionally conservative.
  // Start with 2 bytes for "[]".
  let currentChunkBytes = 2;

  let droppedOversizeItems = 0;

  for (const rawItem of items) {
    // Strip bloated fields (file snapshots, diagnostics) before measuring size
    // so items that are only oversized due to bloat are not dropped.
    const item = stripIngestBloat(rawItem);
    const itemJson = JSON.stringify(item);
    const itemBytes = byteLengthUtf8(itemJson) + 1;

    if (itemBytes > MAX_INGEST_ITEM_BYTES) {
      droppedOversizeItems++;
      continue;
    }

    if (currentChunk.length > 0 && currentChunkBytes + itemBytes > MAX_DO_INGEST_CHUNK_BYTES) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChunkBytes = 2;
    }

    currentChunk.push(item);
    currentChunkBytes += itemBytes;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return {
    chunks,
    droppedOversizeItems,
  };
}
