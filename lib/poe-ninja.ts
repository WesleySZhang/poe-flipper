// poe.ninja has no official docs; endpoints below were found by inspecting the site's own network calls
// and may change without notice (last verified 2026-09-12).
const CURRENCY_OVERVIEW_URL = "https://poe.ninja/poe1/api/economy/stash/current/currency/overview";
const ITEM_OVERVIEW_URL = "https://poe.ninja/poe1/api/economy/stash/current/item/overview";
// poe.ninja's newer Currency Exchange (Faustus)-backed endpoint - see getExchangeOverview.
const EXCHANGE_OVERVIEW_URL = "https://poe.ninja/poe1/api/economy/exchange/current/overview";
const CACHE_TTL_MS = 20 * 60 * 1000;
const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";

// poe.ninja's own item categories keep shifting between the "currency" and "item" overview endpoints
// (last re-verified 2026-09-12: Scarab/Essence/Fossil/DivinationCard/etc. now 404 on item/overview and
// live under currency/overview instead - same currencyTypeName/chaosEquivalent shape as Currency/Fragment).
// A second shift found 2026-09-20: the currency/overview (stash-scrape) endpoint itself now returns
// ZERO lines for every type here except Currency and Fragment - poe.ninja appears to have moved the
// rest fully onto its Currency Exchange-backed data instead (see getExchangeOverview/
// getAllCurrentCurrencyPrices's fallback). Prophecy, Seed, DjinnCoin, HelmetEnchant and Watchstone
// currently have zero lines from BOTH endpoints (no live listings/trades right now, not a bug).
export const CURRENCY_OVERVIEW_TYPES = [
  "Currency",
  "Fragment",
  "DivinationCard",
  "Scarab",
  "Prophecy",
  "Essence",
  "Fossil",
  "Oil",
  "DeliriumOrb",
  "Omen",
  "Resonator",
  "Runegraft",
  "Artifact",
  "Seed",
  "DjinnCoin",
  "HelmetEnchant",
  "Watchstone",
  "Tattoo",
  "AllflameEmber",
] as const;

// Mirrors the "type" values found in the ingested historical item_history table (see scripts/ingest-history.ts).
export const ITEM_OVERVIEW_TYPES = [
  "UniqueWeapon",
  "UniqueArmour",
  "UniqueAccessory",
  "UniqueFlask",
  "UniqueJewel",
  "UniqueMap",
  "UniqueRelic",
  "UniqueIdol",
  "UniqueTincture",
  "SkillGem",
  "ImbuedGem",
  "ClusterJewel",
  "Map",
  "BlightedMap",
  "BlightRavagedMap",
  "ValdoMap",
  "Incubator",
  "Vial",
  "Invitation",
  "Memory",
  "ShrineBelt",
  "Wombgift",
  "KalguuranRune",
  "Beast",
  "Coffin",
  "IncursionTemple",
  "BaseType",
] as const;

export type CurrencyOverviewType = (typeof CURRENCY_OVERVIEW_TYPES)[number];
export type ItemOverviewType = (typeof ITEM_OVERVIEW_TYPES)[number];

/** poe.ninja's 7-point price sparkline: each entry is the % change of that day's price relative to a fixed
 *  base 6-7 days earlier (a stash currency line's first point is 0 - the base itself), oldest first; a point
 *  is null on a day with no price. Verified to match our stored daily history point-for-point (see ml/README.md). */
export interface SparkLine {
  data?: Array<number | null>;
}

export interface CurrencyOverviewLine {
  currencyTypeName: string;
  chaosEquivalent: number;
  receiveSparkLine?: SparkLine;
}

/** Returns the sparkline's points when there are enough to derive any momentum, else undefined. */
export function sparkPointsFrom(line: SparkLine | undefined): Array<number | null> | undefined {
  const data = line?.data;
  return Array.isArray(data) && data.length >= 2 ? data : undefined;
}

/** poe.ninja's catalog entry for one currency - the "tradeId" here is the same short id
 *  (e.g. "chaos", "divine", "alch") the exchange-overview endpoint keys its lines by. */
export interface CurrencyDetail {
  name: string;
  tradeId: string;
}

interface CurrencyOverviewResponse {
  lines?: CurrencyOverviewLine[];
  currencyDetails?: CurrencyDetail[];
}

export interface ItemOverviewLine {
  name: string;
  baseType?: string;
  variant?: string;
  links?: number;
  chaosValue: number;
  /** Distinct sellers currently listing this exact name+variant - see ItemPrice.sellerCount. */
  count?: number;
  sparkLine?: SparkLine;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

// Unofficial, undocumented endpoints - cache aggressively to avoid hammering poe.ninja.
const cache = new Map<string, CacheEntry<unknown>>();

async function fetchJson<T>(url: string): Promise<T | null> {
  const cached = cache.get(url) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) {
      console.warn(`poe.ninja request failed (${res.status}): ${url}`);
      return cached?.data ?? null;
    }
    const data = (await res.json()) as T;
    cache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  } catch (err) {
    console.warn(`poe.ninja request errored: ${url}`, err);
    return cached?.data ?? null;
  }
}

function fetchCurrencyOverviewRaw(league: string, type: CurrencyOverviewType): Promise<CurrencyOverviewResponse | null> {
  const url = `${CURRENCY_OVERVIEW_URL}?league=${encodeURIComponent(league)}&type=${type}`;
  return fetchJson<CurrencyOverviewResponse>(url);
}

export async function getCurrencyOverview(
  league: string,
  type: CurrencyOverviewType
): Promise<CurrencyOverviewLine[]> {
  const data = await fetchCurrencyOverviewRaw(league, type);
  return data?.lines ?? [];
}

/**
 * poe.ninja's Currency Exchange (Faustus)-backed overview - a newer, separate endpoint from the
 * stash-listing scrape above. Verified this tracks Divine Orb within ~5% of GGG's own raw
 * Currency Exchange API data, vs. the stash overview which is derived from public stash tab
 * listings instead of actual completed exchange trades. Lines are keyed by a short "id" (e.g.
 * "chaos", "the-nurse") rather than a display name - resolved either via the response's own
 * `items[].name` (every type, incl. DivinationCard/Scarab/etc. - see getAllCurrentCurrencyPrices)
 * or, for the base Currency bucket specifically, via CurrencyDetail.tradeId from the stash overview
 * responses (kept as the existing path there since it was already verified working).
 */
export interface ExchangeOverviewLine {
  id: string;
  /** Chaos-equivalent price - poe.ninja's exchange overview prices every category against Chaos
   *  Orb as "primary" (verified across Currency, Fragment, Scarab, Essence, DivinationCard, Tattoo,
   *  Fossil), same as CurrencyOverviewLine.chaosEquivalent. */
  primaryValue: number;
  sparkline?: SparkLine;
}

interface ExchangeOverviewItem {
  id: string;
  name: string;
}

interface ExchangeOverviewResponse {
  lines?: ExchangeOverviewLine[];
  /** id->display-name catalog for this same response's lines - present on every type this
   *  endpoint serves (verified on Currency, Scarab, DivinationCard, Essence, Fossil, Tattoo), so a
   *  type with no other name source (see the stash-overview regression below) can still resolve
   *  its lines without a second request. */
  items?: ExchangeOverviewItem[];
}

async function getExchangeOverview(league: string, type: CurrencyOverviewType): Promise<ExchangeOverviewResponse> {
  const url = `${EXCHANGE_OVERVIEW_URL}?league=${encodeURIComponent(league)}&type=${type}`;
  const data = await fetchJson<ExchangeOverviewResponse>(url);
  return { lines: data?.lines ?? [], items: data?.items ?? [] };
}

export async function getItemOverview(league: string, type: ItemOverviewType): Promise<ItemOverviewLine[]> {
  const url = `${ITEM_OVERVIEW_URL}?league=${encodeURIComponent(league)}&type=${type}`;
  const data = await fetchJson<{ lines?: ItemOverviewLine[] }>(url);
  return data?.lines ?? [];
}

export interface CurrencyPrice {
  chaosValue: number;
  /** poe.ninja's last-7-days price path (see SparkLine) - momentum input for lib/prediction-features.ts. */
  spark?: Array<number | null>;
  /** Which CURRENCY_OVERVIEW_TYPES bucket this came from (Currency, Fragment, Scarab, ...) - used for the category filter. */
  type: CurrencyOverviewType;
}

// The stash-listing scrape (fetchCurrencyOverviewRaw) only ever returns rows for these two types -
// verified live 2026-09-20 (see the comment above CURRENCY_OVERVIEW_TYPES) and re-confirmed while
// profiling page load time: every other type returns zero lines AND zero currencyDetails, always.
// Firing that request for the other 17 types was pure wasted latency (~17 extra round-trips per
// cold page load, since they're guaranteed to come back empty) - narrowing to just these two cut a
// real ~1.2s off getAllCurrentCurrencyPrices's cold-cache time. The exchange-overview fetch below
// still runs for every type, since for those other 17 it's the ONLY source that has any data at all.
const STASH_SCRAPE_TYPES: readonly CurrencyOverviewType[] = ["Currency", "Fragment"];

/** Price (+ type, for filtering) keyed by currency/fragment name, merged across all currency overview types. */
export async function getAllCurrentCurrencyPrices(league: string): Promise<Map<string, CurrencyPrice>> {
  const prices = new Map<string, CurrencyPrice>();
  // Both batches requested concurrently - the exchange overview below doesn't depend on the stash
  // batch's results, only on the tradeIdToName lookup built FROM the Currency-type stash response
  // further down, so there's no reason to wait for the stash batch to finish before even starting
  // this one (was previously a fully separate, sequential await AFTER the stash Promise.all -
  // measured at ~1.6s on its own, one of the single slowest calls in the whole fan-out, entirely
  // wasted as serial latency).
  const [stashResults, exchangeResults] = await Promise.all([
    Promise.all(STASH_SCRAPE_TYPES.map((type) => fetchCurrencyOverviewRaw(league, type))),
    Promise.all(CURRENCY_OVERVIEW_TYPES.map((type) => getExchangeOverview(league, type))),
  ]);

  // Currency Exchange's Currency-type lines are keyed by a short id ("chaos", "alch") that its own
  // items[] entries (unlike every other type's - see below) resolve to the SAME name the stash
  // overview already uses, verified independently via currencyDetails - kept as its own path since
  // it predates (and was already verified working for) the fallback this function now also does
  // for every other type.
  const tradeIdToName = new Map<string, string>();
  for (const data of stashResults) {
    for (const detail of data?.currencyDetails ?? []) {
      if (detail.tradeId && detail.name && !tradeIdToName.has(detail.tradeId)) {
        tradeIdToName.set(detail.tradeId, detail.name);
      }
    }
  }

  stashResults.forEach((data, i) => {
    const type = STASH_SCRAPE_TYPES[i];
    for (const line of data?.lines ?? []) {
      if (!prices.has(line.currencyTypeName)) {
        prices.set(line.currencyTypeName, {
          chaosValue: line.chaosEquivalent,
          type,
          spark: sparkPointsFrom(line.receiveSparkLine),
        });
      }
    }
  });
  // Chaos Orb is the implicit baseline and never appears in the overview lines itself.
  if (!prices.has("Chaos Orb")) prices.set("Chaos Orb", { chaosValue: 1, type: "Currency" });

  // poe.ninja's stash-listing scrape (above) now returns zero lines for most non-Currency/Fragment
  // types (Scarab, Essence, Fossil, DivinationCard, Oil, ... - verified live 2026-09-20, no
  // announcement found; presumably poe.ninja itself has moved fully onto Currency Exchange data for
  // these) - so this fallback isn't just "prefer the newer source" for those types, it's the ONLY
  // source they have left. Every exchange-overview type's own `items[]` resolves its lines' short
  // ids to real display names directly (see ExchangeOverviewResponse) - the base Currency type
  // still prefers the tradeIdToName path above instead, since that was independently verified
  // (Divine Orb within ~5% of GGG's own exchange data) and items[] wasn't cross-checked against it.
  exchangeResults.forEach((exchange, i) => {
    const type = CURRENCY_OVERVIEW_TYPES[i];
    const idToName = new Map(exchange.items?.map((item) => [item.id, item.name]));
    for (const line of exchange.lines ?? []) {
      const name = type === "Currency" ? tradeIdToName.get(line.id) : idToName.get(line.id);
      if (!name) continue;
      const existing = prices.get(name);
      // For Currency specifically, exchange data replaces the stash value outright (see above) -
      // for every other type, only fill a gap the stash scrape left empty, so a type that DOES
      // still have working stash data isn't silently overridden by this fallback.
      if (type !== "Currency" && existing) continue;
      const spark = sparkPointsFrom(line.sparkline) ?? existing?.spark;
      prices.set(name, { chaosValue: line.primaryValue, type, spark });
    }
  });

  return prices;
}

export interface ItemPrice {
  chaosValue: number;
  /** Which category bucket this counts as for the category filter - usually one of
   *  ITEM_OVERVIEW_TYPES verbatim (SkillGem, UniqueWeapon, Scarab, ...), but see
   *  correctedItemType() for the one deliberate override. */
  type: string;
  /** How many distinct people are currently selling this exact name+variant, straight from
   *  poe.ninja's own `count` field - undefined if a future response ever omits it. A rare
   *  corrupted-quality gem or influence-exalted base can have as few as 1-4 concurrent sellers, at
   *  which point "the price" is really just whatever those few people happen to be asking, not a
   *  real market - see MIN_ITEM_SELLER_COUNT in flip-suggestions.ts, which uses this to filter such
   *  rows out. Currency overview lines have no equivalent field (poe.ninja aggregates those
   *  stash-tab-wide rather than per-listing), so CurrencyPrice has no counterpart. */
  sellerCount?: number;
  /** poe.ninja's last-7-days price path (see SparkLine) - momentum input for lib/prediction-features.ts. */
  spark?: Array<number | null>;
}

/**
 * poe.ninja files "Vaal Aspect" base-type jewels (e.g. Cooperation) under UniqueJewel, but they
 * behave nothing like a socketed passive-tree jewel that trades on build/meta popularity - they're
 * structurally priced, evergreen items much closer in spirit to Fragment. Corrected once here (and
 * at the equivalent point for historical data, scripts/ingest-history.ts) so every downstream
 * consumer - category filter, badges, the reliability-tier grouping in lib/category-reliability.ts -
 * sees the corrected bucket without needing to know this specific base type exists.
 */
export function correctedItemType(type: string, baseType: string | undefined): string {
  return type === "UniqueJewel" && baseType === "Vaal Aspect" ? "Fragment" : type;
}

// Matches the bucket text ("1-4 links"/"5 links"/"6 links") the ingested historical data already
// uses for its own "Links" CSV column (see scripts/ingest-history.ts) - poe.ninja's live API
// reports an exact link count instead, so it has to be bucketed the same way to line up. Exported
// so scripts/precompute-price-history.ts can write this exact convention into its own generated
// CSVs (see that file for why: it's built to be a drop-in match for poe.ninja's own export format).
export function linksBucketLabel(links: number): string {
  if (links >= 6) return "6 links";
  if (links === 5) return "5 links";
  return "1-4 links";
}

/**
 * Folds poe.ninja's separate links count into the variant discriminator - a linked item prices
 * completely differently from an unlinked one, so it needs to be treated as a distinct item (and
 * shown as "Name (6 links)"), not averaged in with the base item. A variant and a link count can
 * both apply to the same listing (e.g. a mutated "Foulborn" unique), hence the combining rather
 * than one replacing the other.
 */
function effectiveVariant(variant?: string | null, links?: number | null): string | undefined {
  const trimmedVariant = variant?.trim() || undefined;
  const linksText = typeof links === "number" ? linksBucketLabel(links) : undefined;
  if (trimmedVariant && linksText) return `${trimmedVariant}, ${linksText}`;
  return trimmedVariant ?? linksText;
}

/** Price (+ type, for filtering) keyed by item name+variant (see itemPriceKey), merged across all item overview types. */
export async function getAllCurrentItemPrices(league: string): Promise<Map<string, ItemPrice>> {
  const prices = new Map<string, ItemPrice>();
  const results = await Promise.all(ITEM_OVERVIEW_TYPES.map((type) => getItemOverview(league, type)));
  results.forEach((lines, i) => {
    const type = ITEM_OVERVIEW_TYPES[i];
    for (const line of lines) {
      const key = itemPriceKey(line.name, effectiveVariant(line.variant, line.links));
      if (!prices.has(key)) {
        prices.set(key, {
          chaosValue: line.chaosValue,
          type: correctedItemType(type, line.baseType),
          sellerCount: line.count,
          spark: sparkPointsFrom(line.sparkLine),
        });
      }
    }
  });
  return prices;
}

/** Gems/uniques can have wildly different prices per variant (quality, level, corruption) - key on both. */
export function itemPriceKey(name: string, variant?: string | null): string {
  const normalizedVariant = variant?.trim() ?? "";
  return normalizedVariant ? `${name}::${normalizedVariant}` : name;
}

/**
 * Display name for an item + its variant (see effectiveVariant/growth-ratios.ts's equivalent SQL,
 * which fold link count into the variant the same way). "1-4 links" is omitted here - it's still
 * tracked as its own distinct item internally (its price behaves nothing like the base item), but
 * isn't a rare/distinctive enough trait to call out by itself; only "5 links" and "6 links" are
 * notable enough to show.
 */
export function formatItemDisplayName(name: string, variant?: string | null): string {
  if (!variant) return name;
  const shownParts = variant.split(", ").filter((part) => part !== "1-4 links");
  return shownParts.length > 0 ? `${name} (${shownParts.join(", ")})` : name;
}
