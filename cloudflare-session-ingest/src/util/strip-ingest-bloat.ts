type AnyRecord = Record<string, unknown>;

export type StrippableItem = {
  type: string;
  data: unknown;
};

/**
 * Strip bloated fields from ingest items before storage.
 *
 * Three fields are stripped:
 * 1. session.summary.diffs[].before / .after — full file snapshots (50-400KB)
 * 2. part.state.metadata.filediff.before / .after — duplicate file snapshots (50-300KB)
 * 3. part.state.metadata.diagnostics — all-project LSP diagnostics (100-500KB)
 *
 * These fields are only needed for local UI rendering and are not used by the
 * cloud (share page, metrics, export). Stripping them reduces ingest payload
 * size by 50-77%.
 *
 * Returns a new item; does not mutate the input.
 */
export function stripIngestBloat<T extends StrippableItem>(item: T): T {
  if (item.type === 'session') return stripSessionBloat(item);
  if (item.type === 'part') return stripPartBloat(item);
  return item;
}

function stripSessionBloat<T extends StrippableItem>(item: T): T {
  const data = item.data as AnyRecord | null | undefined;
  if (!data) return item;

  const summary = data.summary as AnyRecord | null | undefined;
  if (!summary) return item;

  const diffs = summary.diffs as AnyRecord[] | null | undefined;
  if (!diffs || !Array.isArray(diffs)) return item;

  const stripped = diffs.map(diff => {
    const { before, after, ...rest } = diff;
    return rest;
  });

  return {
    ...item,
    data: {
      ...data,
      summary: {
        ...summary,
        diffs: stripped,
      },
    },
  };
}

function stripPartBloat<T extends StrippableItem>(item: T): T {
  const data = item.data as AnyRecord | null | undefined;
  if (!data) return item;

  const state = data.state as AnyRecord | null | undefined;
  if (!state) return item;

  const metadata = state.metadata as AnyRecord | null | undefined;
  if (!metadata) return item;

  const stripped: AnyRecord = { ...metadata };

  // Strip diagnostics entirely — not used by cloud
  delete stripped.diagnostics;

  // Strip filediff.before / .after — keep the rest (file, additions, deletions)
  const filediff = stripped.filediff as AnyRecord | null | undefined;
  if (filediff && typeof filediff === 'object') {
    const { before, after, ...rest } = filediff;
    stripped.filediff = rest;
  }

  return {
    ...item,
    data: {
      ...data,
      state: {
        ...state,
        metadata: stripped,
      },
    },
  };
}
