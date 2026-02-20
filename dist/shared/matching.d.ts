/**
 * Shared fuzzy matching utilities for health concern titles.
 */
/**
 * Find the best matching title from a list of existing titles.
 * Returns the matched title string or null if no match found.
 *
 * Matching strategy (in order):
 * 1. Exact match (case-insensitive)
 * 2. Substring match (either direction)
 * 3. Significant word overlap
 */
export declare function findBestConcernMatch(title: string, existingTitles: string[]): string | null;
//# sourceMappingURL=matching.d.ts.map