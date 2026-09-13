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

export interface CurrencyOverviewLine {
  currencyTypeName: string;
  chaosEquivalent: number;
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
 * listings instead of actual completed exchange trades. Lines are keyed by a short "tradeId"
 * (e.g. "chaos", "divine", "alch") rather than a display name - resolve via CurrencyDetail.tradeId
 * from the stash overview responses (see getAllCurrentCurrencyPrices).
 */
export interface ExchangeOverviewLine {
  id: string;
  /** Chaos-equivalent price - poe.ninja's exchange overview prices every category against Chaos
   *  Orb as "primary" (verified across Currency, Fragment, Scarab, Essence, DivinationCard, Tattoo,
   *  Fossil), same as CurrencyOverviewLine.chaosEquivalent. */
  primaryValue: number;
}

async function getExchangeOverview(league: string, type: CurrencyOverviewType): Promise<ExchangeOverviewLine[]> {
  const url = `${EXCHANGE_OVERVIEW_URL}?league=${encodeURIComponent(league)}&type=${type}`;
  const data = await fetchJson<{ lines?: ExchangeOverviewLine[] }>(url);
  return data?.lines ?? [];
}

export async function getItemOverview(league: string, type: ItemOverviewType): Promise<ItemOverviewLine[]> {
  const url = `${ITEM_OVERVIEW_URL}?league=${encodeURIComponent(league)}&type=${type}`;
  const data = await fetchJson<{ lines?: ItemOverviewLine[] }>(url);
  return data?.lines ?? [];
}

export interface CurrencyPrice {
  chaosValue: number;
  /** Which CURRENCY_OVERVIEW_TYPES bucket this came from (Currency, Fragment, Scarab, ...) - used for the category filter. */
  type: CurrencyOverviewType;
}

/** Price (+ type, for filtering) keyed by currency/fragment name, merged across all currency overview types. */
export async function getAllCurrentCurrencyPrices(league: string): Promise<Map<string, CurrencyPrice>> {
  const prices = new Map<string, CurrencyPrice>();
  const stashResults = await Promise.all(CURRENCY_OVERVIEW_TYPES.map((type) => fetchCurrencyOverviewRaw(league, type)));

  // Currency Exchange lines below are keyed by a short id ("chaos", "alch") rather than a display
  // name - build the id->name lookup from whichever stash responses happen to carry it, since
  // currencyDetails is poe.ninja's own catalog data and stable across categories.
  const tradeIdToName = new Map<string, string>();
  for (const data of stashResults) {
    for (const detail of data?.currencyDetails ?? []) {
      if (detail.tradeId && detail.name && !tradeIdToName.has(detail.tradeId)) {
        tradeIdToName.set(detail.tradeId, detail.name);
      }
    }
  }

  stashResults.forEach((data, i) => {
    const type = CURRENCY_OVERVIEW_TYPES[i];
    for (const line of data?.lines ?? []) {
      if (!prices.has(line.currencyTypeName)) {
        prices.set(line.currencyTypeName, { chaosValue: line.chaosEquivalent, type });
      }
    }
  });
  // Chaos Orb is the implicit baseline and never appears in the overview lines itself.
  if (!prices.has("Chaos Orb")) prices.set("Chaos Orb", { chaosValue: 1, type: "Currency" });

  // The base "Currency" bucket (Chaos/Divine/Exalted/Alch/...) prefers Currency Exchange pricing
  // over the stash-listing scrape above - see getExchangeOverview's comment. Falls back to the
  // stash value set above for any line whose tradeId doesn't resolve to a name.
  const exchangeLines = await getExchangeOverview(league, "Currency");
  for (const line of exchangeLines) {
    const name = tradeIdToName.get(line.id);
    if (name) prices.set(name, { chaosValue: line.primaryValue, type: "Currency" });
  }

  return prices;
}

export interface ItemPrice {
  chaosValue: number;
  /** Which ITEM_OVERVIEW_TYPES bucket this came from (SkillGem, UniqueWeapon, Scarab, ...) - used for the category filter. */
  type: ItemOverviewType;
}

// Matches the bucket text ("1-4 links"/"5 links"/"6 links") the ingested historical data already
// uses for its own "Links" CSV column (see scripts/ingest-history.ts) - poe.ninja's live API
// reports an exact link count instead, so it has to be bucketed the same way to line up.
function linksBucketLabel(links: number): string {
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
        prices.set(key, { chaosValue: line.chaosValue, type });
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
