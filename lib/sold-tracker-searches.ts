import { applyTrackerRules, describeQuery, parseTradeSearchUrl, type TradeQuery } from "./trade-query";

/**
 * Reads sold-tracker/searches.md - shared by the tracker (scripts/track-sold-listings.ts) and its PR
 * check (scripts/check-sold-searches.ts), so both see exactly the same searches. Server/script only.
 */
export const SEARCHES_DOC = "sold-tracker/searches.md";

export interface TrackedSearch {
  label: string;
  /** The link as written. */
  url: string;
  /** The link's query with the tracker's rules applied; absent when the link can't be read. */
  query?: TradeQuery;
  error?: string;
}

/**
 * The links under the "## Searches" heading: one per list item, either `[label](link)` or a bare
 * link (labelled with the item it searches for). A link that can't be read, or reuses a label
 * (labels tie listings to their searches), comes back with `error` set.
 */
export function parseSearchesDoc(text: string): TrackedSearch[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Searches\s*$/i.test(l));
  if (start === -1) throw new Error(`${SEARCHES_DOC} has no "## Searches" heading`);
  const out: TrackedSearch[] = [];
  const labels = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const item = line.match(/^\s*[-*]\s+(.*)$/)?.[1];
    if (!item) continue;
    const md = item.match(/\[([^\]]+)\]\((\S+?)\)/);
    const url = md?.[2] ?? item.match(/https?:\/\/\S+/)?.[0];
    if (!url) continue;
    let label = md?.[1]?.trim();
    let search: TrackedSearch;
    try {
      const { query } = parseTradeSearchUrl(url);
      label ||= describeQuery(query) ?? `Search ${out.length + 1}`;
      search = { label, url, query: applyTrackerRules(query) };
    } catch (e) {
      search = { label: label || `Search ${out.length + 1}`, url, error: (e as Error).message };
    }
    if (labels.has(search.label)) {
      search = { label: `${search.label} (${out.length + 1})`, url, error: `Duplicate label "${search.label}" - give each search its own` };
    }
    labels.add(search.label);
    out.push(search);
  }
  return out;
}
