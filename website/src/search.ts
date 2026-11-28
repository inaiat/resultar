import type { SearchEntry } from "./generated/site-data.js";

export interface RankedSearchResult {
  readonly entry: SearchEntry;
  readonly score: number;
}

export const searchDocs = (
  index: readonly SearchEntry[],
  rawQuery: string,
  limit = 16,
): readonly RankedSearchResult[] => {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) {
    return index
      .filter((entry) => entry.kind === "guide")
      .slice(0, 8)
      .map((entry) => ({ entry, score: 1 }));
  }

  const terms = query.split(/\s+/u).filter((term) => term.length > 0);
  const scored: RankedSearchResult[] = [];

  for (const entry of index) {
    const titleLower = entry.title.toLowerCase();
    const subtitleLower = entry.subtitle.toLowerCase();
    const keywordsLower = entry.keywords.toLowerCase();

    let matchesAll = true;
    let score = 0;

    for (const term of terms) {
      if (titleLower === term) {
        score += 120;
      } else if (titleLower.startsWith(term)) {
        score += 80;
      } else if (titleLower.includes(term)) {
        score += 50;
      } else if (subtitleLower.includes(term)) {
        score += 25;
      } else if (keywordsLower.includes(term)) {
        score += 10;
      } else {
        matchesAll = false;
        break;
      }
    }

    if (!matchesAll) continue;
    if (entry.kind === "guide") score += 15;
    else if (entry.kind === "rule") score += 12;
    else if (entry.kind === "api") score += 10;

    // Keep current Result + ResultTask documentation ahead of historical/deprecated references.
    if (
      entry.route.startsWith("#/docs/v4-migration") ||
      entry.route.startsWith("#/docs/rfcs/") ||
      titleLower.includes("deprecated") ||
      titleLower.includes("resultasync") ||
      subtitleLower.includes("v4 migration")
    ) {
      score -= 35;
    }

    scored.push({ entry, score });
  }

  return scored
    .toSorted(
      (left, right) =>
        right.score - left.score || left.entry.title.localeCompare(right.entry.title),
    )
    .slice(0, limit);
};
