/**
 * Shared fuzzy matching utilities for health concern titles.
 */

const MATCHING_STOP_WORDS = new Set([
  'de', 'la', 'el', 'en', 'y', 'del', 'a', 'los', 'las', 'un', 'una', 'por',
  'the', 'and', 'in', 'of', 'a', 'an', 'for', 'with', 'on', 'at', 'to',
  'da', 'do', 'das', 'dos', 'no', 'na', 'em', 'com', 'para', 'um', 'uma',
  'le', 'la', 'les', 'des', 'du', 'au', 'aux', 'avec', 'dans', 'pour',
]);

/**
 * Find the best matching title from a list of existing titles.
 * Returns the matched title string or null if no match found.
 *
 * Matching strategy (in order):
 * 1. Exact match (case-insensitive)
 * 2. Substring match (either direction)
 * 3. Significant word overlap
 */
export function findBestConcernMatch(title: string, existingTitles: string[]): string | null {
  const normalizedTitle = title.toLowerCase().trim();

  // 1. Exact match
  for (const existing of existingTitles) {
    if (existing.toLowerCase().trim() === normalizedTitle) {
      return existing;
    }
  }

  // 2. Substring match
  for (const existing of existingTitles) {
    const existingLower = existing.toLowerCase().trim();
    if (existingLower.includes(normalizedTitle) || normalizedTitle.includes(existingLower)) {
      return existing;
    }
  }

  // 3. Word overlap
  const titleWords = getSignificantWords(normalizedTitle);
  if (titleWords.length === 0) return null;

  for (const existing of existingTitles) {
    const existingWords = getSignificantWords(existing.toLowerCase().trim());
    if (existingWords.length === 0) continue;

    const overlap = titleWords.filter(w => existingWords.includes(w)).length;
    const overlapRatio = overlap / Math.min(titleWords.length, existingWords.length);

    if (overlapRatio >= 0.5 && overlap >= 1) {
      return existing;
    }
  }

  return null;
}

function getSignificantWords(text: string): string[] {
  return text.split(/\s+/).filter(w => w.length > 2 && !MATCHING_STOP_WORDS.has(w));
}
