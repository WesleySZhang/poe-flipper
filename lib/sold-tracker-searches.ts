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

/** The doc's list lines under "## Searches": where each one is, and what it parses to. */
function searchLines(lines: string[]): Array<{ index: number; search: TrackedSearch }> {
  const start = lines.findIndex((l) => /^##\s+Searches\s*$/i.test(l));
  if (start === -1) throw new Error(`${SEARCHES_DOC} has no "## Searches" heading`);
  const out: Array<{ index: number; search: TrackedSearch }> = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    const [search] = parseSearchesDoc(`## Searches\n${lines[i]}`);
    if (search) out.push({ index: i, search });
  }
  return out;
}

/**
 * Adds a search as the last list item under "## Searches" (the "Add or remove a sold tracker
 * search" workflow). Throws when the link can't be read, or the label or link is already there.
 * `label` defaults to the item the link searches for. Returns the new text and the label used.
 */
export function addSearchToDoc(text: string, link: string, label?: string): { text: string; label: string } {
  const url = link.trim();
  const [parsed] = parseSearchesDoc(`## Searches\n- ${url}`);
  if (!parsed || parsed.error) throw new Error(parsed?.error ?? `Not a trade site search link: ${url}`);
  const name = label?.trim() || parsed.label;
  if (/[\[\]\r\n]/.test(name)) throw new Error(`A label can't contain [, ] or a line break: ${name}`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const existing = searchLines(lines);
  const sameLabel = existing.find((e) => e.search.label === name);
  if (sameLabel) throw new Error(`A search is already labelled "${name}" - pick another label`);
  const sameLink = existing.find((e) => e.search.url === url);
  if (sameLink) throw new Error(`That link is already tracked as "${sameLink.search.label}"`);
  const item = `- [${name}](${url})`;
  if (existing.length) {
    lines.splice(existing[existing.length - 1].index + 1, 0, item);
  } else {
    // The first item: keep a blank line between it and the heading.
    const start = lines.findIndex((l) => /^##\s+Searches\s*$/i.test(l));
    if (lines[start + 1] === "") lines.splice(start + 2, 0, item);
    else lines.splice(start + 1, 0, "", item);
  }
  return { text: lines.join(eol), label: name };
}

/** Removes the search with this label, or this link. Throws when none matches. */
export function removeSearchFromDoc(text: string, labelOrLink: string): { text: string; label: string } {
  const key = labelOrLink.trim();
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const existing = searchLines(lines);
  const match = existing.find((e) => e.search.label === key || e.search.url === key);
  if (!match) {
    const labels = existing.map((e) => `"${e.search.label}"`).join(", ") || "none";
    throw new Error(`No search labelled or linked "${key}" (searches: ${labels})`);
  }
  lines.splice(match.index, 1);
  return { text: lines.join(eol), label: match.search.label };
}
