"use strict";
/**
 * Shared fuzzy matching utilities for health concern titles.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.findBestConcernMatch = findBestConcernMatch;
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
function findBestConcernMatch(title, existingTitles) {
    const normalizedTitle = title.toLowerCase().trim();
    // 1. Exact match
    for (const existing of existingTitles) {
        if (existing.toLowerCase().trim() === normalizedTitle) {
            return existing;
        }
    }
    // 2. Substring match — only when the shorter string is 4+ chars
    //    (prevents "Eye" matching "Stye" or "Cold" matching "Scaffold")
    for (const existing of existingTitles) {
        const existingLower = existing.toLowerCase().trim();
        const shorter = normalizedTitle.length <= existingLower.length ? normalizedTitle : existingLower;
        if (shorter.length >= 4) {
            if (existingLower.includes(normalizedTitle) || normalizedTitle.includes(existingLower)) {
                return existing;
            }
        }
    }
    // 3. Word overlap — require 2+ shared significant words
    //    (prevents "Back Pain" matching "Knee Pain" on just "Pain")
    const titleWords = getSignificantWords(normalizedTitle);
    if (titleWords.length === 0)
        return null;
    for (const existing of existingTitles) {
        const existingWords = getSignificantWords(existing.toLowerCase().trim());
        if (existingWords.length === 0)
            continue;
        const overlap = titleWords.filter(w => existingWords.includes(w)).length;
        const overlapRatio = overlap / Math.min(titleWords.length, existingWords.length);
        if (overlapRatio >= 0.5 && overlap >= 2) {
            return existing;
        }
    }
    return null;
}
function getSignificantWords(text) {
    return text.split(/\s+/).filter(w => w.length > 2 && !MATCHING_STOP_WORDS.has(w));
}
//# sourceMappingURL=matching.js.map