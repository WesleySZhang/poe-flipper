import "server-only";
import { formatItemDisplayName, parseItemPriceKey } from "./poe-ninja";
import { getCurrencyPricesPreferSnapshot, getItemPricesPreferSnapshot } from "./price-snapshot";

/**
 * Name search over everything poe.ninja currently prices, for the header's global search box - so
 * it also finds an item with no prediction/history at all (the detail page handles that case),
 * unlike matching against lib/flip-suggestions.ts's candidates. Reads the daily price snapshot (same
 * source as the detail page, live fallback if missing), so a query costs an in-memory scan, not a
 * poe.ninja request.
 */
export interface ItemSearchResult {
  /** Which detail-page route segment to link to - "currency" wins for a name priced in both maps,
   *  the same direction components/item-detail-panel.tsx's own fallback resolves. */
  category: "currency" | "item";
  name: string;
  variant?: string;
  displayName: string;
  /** poe.ninja's own bucket (Scarab, SkillGem, ...), shown as a small hint next to the name. */
  type: string;
}

interface IndexEntry extends ItemSearchResult {
  lower: string;
}

let index: { currency: object; items: object; entries: IndexEntry[] } | undefined;

async function getIndex(league: string): Promise<IndexEntry[]> {
  const [currency, items] = await Promise.all([
    getCurrencyPricesPreferSnapshot(league),
    getItemPricesPreferSnapshot(league),
  ]);
  // Same Map objects come back until the underlying snapshot/cache turns over, so identity is a
  // valid "nothing changed" check - the ~24k-entry index is rebuilt only then.
  if (index && index.currency === currency && index.items === items) return index.entries;

  const entries: IndexEntry[] = [];
  const seen = new Set<string>();
  for (const [name, price] of currency) {
    seen.add(name);
    entries.push({ category: "currency", name, displayName: name, type: price.type, lower: name.toLowerCase() });
  }
  for (const [key, price] of items) {
    const { name, variant } = parseItemPriceKey(key);
    if (!variant && seen.has(name)) continue; // already listed as currency
    const displayName = formatItemDisplayName(name, variant);
    entries.push({ category: "item", name, variant, displayName, type: price.type, lower: displayName.toLowerCase() });
  }
  index = { currency, items, entries };
  return entries;
}

// Lower rank = better: a name that starts with the query, then one with a word that does, then any
// other substring hit.
function rank(lower: string, query: string): number {
  if (lower.startsWith(query)) return 0;
  if (lower.includes(` ${query}`) || lower.includes(`(${query}`)) return 1;
  return lower.includes(query) ? 2 : -1;
}

export async function searchItems(league: string, query: string, limit: number): Promise<ItemSearchResult[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Array<{ entry: IndexEntry; rank: number }> = [];
  for (const entry of await getIndex(league)) {
    const r = rank(entry.lower, q);
    if (r >= 0) hits.push({ entry, rank: r });
  }
  hits.sort((a, b) => a.rank - b.rank || a.entry.lower.length - b.entry.lower.length || a.entry.lower.localeCompare(b.entry.lower));
  return hits.slice(0, limit).map(({ entry }) => ({
    category: entry.category,
    name: entry.name,
    variant: entry.variant,
    displayName: entry.displayName,
    type: entry.type,
  }));
}
