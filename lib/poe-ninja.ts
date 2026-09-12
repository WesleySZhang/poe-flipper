// poe.ninja has no official docs; endpoints below were found by inspecting the site's own network calls
// and may change without notice (last verified 2026-09-12).
const CURRENCY_OVERVIEW_URL = "https://poe.ninja/poe1/api/economy/stash/current/currency/overview";
const ITEM_OVERVIEW_URL = "https://poe.ninja/poe1/api/economy/stash/current/item/overview";
const CACHE_TTL_MS = 20 * 60 * 1000;
const USER_AGENT = "poe-trade-assistant/0.1.0 (personal, non-commercial; unaffiliated with GGG)";

export const CURRENCY_OVERVIEW_TYPES = ["Currency", "Fragment"] as const;

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
  "DivinationCard",
  "SkillGem",
  "ImbuedGem",
  "ClusterJewel",
  "Map",
  "BlightedMap",
  "BlightRavagedMap",
  "ValdoMap",
  "Scarab",
  "Prophecy",
  "Essence",
  "Fossil",
  "Incubator",
  "Oil",
  "Vial",
  "DeliriumOrb",
  "Invitation",
  "Omen",
  "Resonator",
  "Memory",
  "Runegraft",
  "Artifact",
  "Seed",
  "ShrineBelt",
  "Wombgift",
  "KalguuranRune",
  "DjinnCoin",
  "HelmetEnchant",
  "Beast",
  "Coffin",
  "Watchstone",
  "Tattoo",
  "AllflameEmber",
  "IncursionTemple",
] as const;

export type CurrencyOverviewType = (typeof CURRENCY_OVERVIEW_TYPES)[number];
export type ItemOverviewType = (typeof ITEM_OVERVIEW_TYPES)[number];

export interface CurrencyOverviewLine {
  currencyTypeName: string;
  chaosEquivalent: number;
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

export async function getCurrencyOverview(
  league: string,
  type: CurrencyOverviewType
): Promise<CurrencyOverviewLine[]> {
  const url = `${CURRENCY_OVERVIEW_URL}?league=${encodeURIComponent(league)}&type=${type}`;
  const data = await fetchJson<{ lines?: CurrencyOverviewLine[] }>(url);
  return data?.lines ?? [];
}

export async function getItemOverview(league: string, type: ItemOverviewType): Promise<ItemOverviewLine[]> {
  const url = `${ITEM_OVERVIEW_URL}?league=${encodeURIComponent(league)}&type=${type}`;
  const data = await fetchJson<{ lines?: ItemOverviewLine[] }>(url);
  return data?.lines ?? [];
}

/** Chaos-value price map keyed by currency/fragment name, merged across all currency overview types. */
export async function getAllCurrentCurrencyPrices(league: string): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const results = await Promise.all(CURRENCY_OVERVIEW_TYPES.map((type) => getCurrencyOverview(league, type)));
  for (const lines of results) {
    for (const line of lines) {
      prices.set(line.currencyTypeName, line.chaosEquivalent);
    }
  }
  // Chaos Orb is the implicit baseline and never appears in the overview lines itself.
  prices.set("Chaos Orb", 1);
  return prices;
}

/** Chaos-value price map keyed by item name+variant (see itemPriceKey), merged across all item overview types. */
export async function getAllCurrentItemPrices(league: string): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const results = await Promise.all(ITEM_OVERVIEW_TYPES.map((type) => getItemOverview(league, type)));
  for (const lines of results) {
    for (const line of lines) {
      const key = itemPriceKey(line.name, line.variant);
      if (!prices.has(key)) {
        prices.set(key, line.chaosValue);
      }
    }
  }
  return prices;
}

/** Gems/uniques can have wildly different prices per variant (quality, level, corruption) - key on both. */
export function itemPriceKey(name: string, variant?: string | null): string {
  const normalizedVariant = variant?.trim() ?? "";
  return normalizedVariant ? `${name}::${normalizedVariant}` : name;
}
