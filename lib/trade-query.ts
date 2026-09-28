import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Trade site search links -> the query they run, for the sold listing tracker
 * (scripts/track-sold-listings.ts). Server/script only (node:zlib).
 *
 * A link copied from the trade site is `/trade/search/<League>/<id>`, where the id is the query
 * itself: gzipped JSON, base64url ("H4sI..." is gzip's header). The API can't look an id up
 * (GET /api/trade/search/<League>/<id> is a 404), so decoding it locally is the only way - and it
 * costs no request. Links this app builds put the JSON in `?q=` instead (lib/trade-site.ts).
 */
export type TradeQuery = Record<string, unknown> & {
  status?: { option: string };
  filters?: Record<string, { filters?: Record<string, unknown>; disabled?: boolean }>;
};

const GZIP_BASE64_PREFIX = "H4sI";

export function parseTradeSearchUrl(url: string): { league: string; query: TradeQuery } {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/\/trade\/search\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!match) throw new Error(`Not a trade site search link: ${url}`);
  const league = decodeURIComponent(match[1]);
  const q = parsed.searchParams.get("q");
  if (q) {
    const json = JSON.parse(q) as { query?: TradeQuery } & TradeQuery;
    return { league, query: json.query ?? json };
  }
  const id = match[2];
  if (!id) throw new Error(`Link has no search in it: ${url}`);
  if (!id.startsWith(GZIP_BASE64_PREFIX)) {
    throw new Error(`Can't read this search id (${id}) - copy the link again from the trade site: ${url}`);
  }
  return { league, query: JSON.parse(gunzipSync(Buffer.from(id, "base64url")).toString("utf8")) as TradeQuery };
}

/** The link form the trade site itself uses - for the tracker's own default searches. */
export function tradeSearchUrlForQuery(league: string, query: TradeQuery): string {
  const id = gzipSync(Buffer.from(JSON.stringify(query))).toString("base64url");
  return `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}/${id}`;
}

// The trade site's listing-age options, shortest first. The tracker keeps a link's own age filter
// when it's a week or less, else caps it at a week.
const INDEXED_OPTIONS = ["1hour", "3hours", "12hours", "1day", "3days", "1week"];
export const TRACKER_MAX_LISTING_AGE = "1week";

export interface TrackerRules {
  /** Lowest price tracked, in divines. A link's own divine minimum wins when it's higher. */
  minDivines: number;
}

/**
 * The tracker's rules on top of a link's own filters: instant buyout only (status `securable`), at
 * least `minDivines`, listed in the last week. Instant buyout rules out offline sellers and bait
 * (weeks-old 1c listings): its price is what a buyer really pays, and the seller needn't be online.
 */
export function applyTrackerRules(query: TradeQuery, rules: TrackerRules): TradeQuery {
  const filters = { ...(query.filters ?? {}) };
  const trade = { ...(filters.trade_filters ?? {}), disabled: false };
  const tradeFilters = { ...(trade.filters ?? {}) };

  const price = tradeFilters.price as { min?: number; max?: number; option?: string } | undefined;
  const linkMin = price?.option === "divine" && typeof price.min === "number" ? price.min : 0;
  const linkMax = price?.option === "divine" && typeof price.max === "number" ? price.max : undefined;
  tradeFilters.price = { min: Math.max(rules.minDivines, linkMin), ...(linkMax !== undefined ? { max: linkMax } : {}), option: "divine" };

  const indexed = (tradeFilters.indexed as { option?: string } | undefined)?.option;
  tradeFilters.indexed = { option: indexed && INDEXED_OPTIONS.includes(indexed) ? indexed : TRACKER_MAX_LISTING_AGE };

  trade.filters = tradeFilters;
  filters.trade_filters = trade;
  return { ...query, status: { option: "securable" }, filters };
}

/** A short label for a link with none: the item name or base type it searches for. */
export function describeQuery(query: TradeQuery): string | undefined {
  const name = typeof query.name === "string" ? query.name : undefined;
  const type = typeof query.type === "string" ? query.type : undefined;
  return name ?? type;
}
