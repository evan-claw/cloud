/** Split a comma-separated region string into an array. */
export function parseRegions(regionList: string): string[] {
  return regionList
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);
}

/** Fisher-Yates shuffle (in-place). Returns the same array for chaining. */
export function shuffleRegions(regions: string[]): string[] {
  for (let i = regions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = regions[i];
    regions[i] = regions[j];
    regions[j] = tmp;
  }
  return regions;
}

/**
 * Move a failed region to the end of the list so we try other regions first.
 * E.g. deprioritizeRegion(['dfw', 'yyz', 'cdg'], 'dfw') → ['yyz', 'cdg', 'dfw']
 */
export function deprioritizeRegion(regions: string[], failedRegion: string | null): string[] {
  if (!failedRegion) return regions;
  const without = regions.filter(r => r !== failedRegion);
  return without.length < regions.length ? [...without, failedRegion] : regions;
}
