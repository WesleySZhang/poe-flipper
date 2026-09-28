import { CURRENT_LEAGUE } from "./league-recency";

/**
 * Links to the official trade site for items that aren't on the Currency Exchange - uniques,
 * including the Vaal Aspect ones lib/poe-ninja.ts's correctedItemType files under Fragment. The
 * search sits in the link itself (`?q=<query>`), so it runs in the user's browser against their own
 * rate limit, never through this app's server.
 *
 * The query: sellers online or with instant buyout ("available"), cheapest first, one listing per
 * seller (collapse), so a single seller's many listings or a long-offline one don't set the price.
 * Pure, so components can import it.
 */
const TRADE_SITE = "https://www.pathofexile.com";
// Mutated uniques: poe.ninja names them "Foulborn <unique>", the trade site doesn't know that name
// ("Unknown item name") - it's the base unique with the mutated filter.
const FOULBORN_PREFIX = "Foulborn ";

/** True for an item bought on the trade site, not the Currency Exchange (see the module doc). */
export function isTradeSiteItem(category: "currency" | "item", type: string | undefined): boolean {
  return category === "item" && type !== undefined && (type.startsWith("Unique") || type === "Fragment");
}

export interface TradeSearchOptions {
  /** Only items at or above this item level - e.g. the Dust Value page's item level. */
  minItemLevel?: number;
}

export function tradeSearchUrl(name: string, variant?: string, options: TradeSearchOptions = {}): string {
  const mutated = name.startsWith(FOULBORN_PREFIX);
  const filters: Record<string, { filters: Record<string, unknown> }> = {
    trade_filters: { filters: { collapse: { option: "true" } } },
  };
  const miscFilters: Record<string, unknown> = {};
  if (mutated) miscFilters.mutated = { option: "true" };
  if (options.minItemLevel !== undefined) miscFilters.ilvl = { min: options.minItemLevel };
  if (Object.keys(miscFilters).length > 0) filters.misc_filters = { filters: miscFilters };
  // poe.ninja folds 5- and 6-link lines into the variant ("6 links"; see effectiveVariant).
  const links = variant?.match(/\b([56]) links\b/)?.[1];
  if (links) filters.socket_filters = { filters: { links: { min: Number(links) } } };

  const query = {
    query: {
      status: { option: "available" },
      name: mutated ? name.slice(FOULBORN_PREFIX.length) : name,
      stats: [{ type: "and", filters: [] }],
      filters,
    },
    sort: { price: "asc" },
  };
  return `${TRADE_SITE}/trade/search/${encodeURIComponent(CURRENT_LEAGUE)}?q=${encodeURIComponent(JSON.stringify(query))}`;
}
