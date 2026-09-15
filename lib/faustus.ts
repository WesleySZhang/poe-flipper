/**
 * GGG's official Currency Exchange (the in-game "Faustus" NPC) trade-history API - a real, public,
 * no-auth endpoint (https://web.poecdn.com/api/currency-exchange), confirmed by GGG's own developer
 * docs and by pulling live data during development. Used as a fallback "now" price for the flip
 * suggestions table when poe.ninja hasn't listed an item yet (a real gap for a brand-new or
 * low-volume item early in a league) - poe.ninja's own live-price scrape stays the primary source
 * everywhere; this only fills a hole poe.ninja itself leaves.
 *
 * The one hard problem: the endpoint identifies every item by GGG's internal game-file path (e.g.
 * "Metadata/Items/Currency/CurrencyRerollRare" for Chaos Orb), never a display name, and GGG's own
 * name-lookup endpoint (the trade site's static data) is Cloudflare-blocked without an approved
 * OAuth application - not a quick add. A first attempt at building this mapping by correlating GGG's
 * computed exchange rate against poe.ninja's known chaos price for the closest-valued currency
 * proved far too unreliable: with hundreds of tradeable items, many share a near-identical price at
 * any given hour, so pure value-correlation produced obviously wrong pairings (e.g. Glassblower's
 * Bauble matched to an unrelated Heist currency worth the same that hour). scripts/build-faustus-
 * mapping.ts is what's left of that attempt - repurposed into a validator that checks each entry
 * below actually exists in live data and is roughly in line with poe.ninja's price, rather than a
 * discovery tool.
 *
 * The list below is instead hand-built from GGG's own internal naming convention, which has stayed
 * stable across years of the game (CurrencyReroll* = randomizes something, CurrencyUpgrade* = raises
 * item rarity, CurrencyAddMod* = adds a modifier, etc.) - restricted to the evergreen currency set
 * (present in every/most leagues), since a Fragment/Scarab/Essence/Tattoo item is already covered by
 * poe.ninja's regular per-category overview and is far less likely to be the "missing" case this
 * exists for. Deliberately NOT exhaustive - an unmapped currency just falls back to whatever
 * poe.ninja already provides (or nothing, same as today), never worse than the status quo.
 */
import "server-only";

const EXCHANGE_URL = "https://web.poecdn.com/api/currency-exchange";
const CACHE_TTL_MS = 20 * 60 * 1000; // same cadence as poe-ninja.ts's other overview caches
const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
const CHAOS_ID = "Metadata/Items/Currency/CurrencyRerollRare";
const DIVINE_ID = "Metadata/Items/Currency/CurrencyModValues";

export const FAUSTUS_NAME_TO_ID: Readonly<Record<string, string>> = {
  "Chaos Orb": "Metadata/Items/Currency/CurrencyRerollRare",
  "Divine Orb": "Metadata/Items/Currency/CurrencyModValues",
  "Exalted Orb": "Metadata/Items/Currency/CurrencyAddModToRare",
  "Regal Orb": "Metadata/Items/Currency/CurrencyUpgradeMagicToRare",
  "Vaal Orb": "Metadata/Items/Currency/CurrencyCorrupt",
  "Orb of Alchemy": "Metadata/Items/Currency/CurrencyUpgradeToRare",
  "Orb of Chance": "Metadata/Items/Currency/CurrencyUpgradeRandomly",
  "Orb of Fusing": "Metadata/Items/Currency/CurrencyRerollSocketLinks",
  "Jeweller's Orb": "Metadata/Items/Currency/CurrencyRerollSocketNumbers",
  "Chromatic Orb": "Metadata/Items/Currency/CurrencyRerollSocketColours",
  "Orb of Scouring": "Metadata/Items/Currency/CurrencyConvertToNormal",
  "Orb of Transmutation": "Metadata/Items/Currency/CurrencyUpgradeToMagic",
  "Orb of Augmentation": "Metadata/Items/Currency/CurrencyAddModToMagic",
  "Orb of Alteration": "Metadata/Items/Currency/CurrencyRerollMagic",
  "Portal Scroll": "Metadata/Items/Currency/CurrencyPortal",
  "Scroll of Wisdom": "Metadata/Items/Currency/CurrencyIdentification",
  "Blessed Orb": "Metadata/Items/Currency/CurrencyRerollImplicit",
  "Orb of Regret": "Metadata/Items/Currency/CurrencyPassiveRefund",
  "Orb of Annulment": "Metadata/Items/Currency/CurrencyRemoveMod",
  "Mirror of Kalandra": "Metadata/Items/Currency/CurrencyDuplicate",
  "Mirror Shard": "Metadata/Items/Currency/CurrencyDuplicateShard",
  "Awakener's Orb": "Metadata/Items/Currency/CurrencyUpgradeInfluenceMod",
  "Hinekora's Lock": "Metadata/Items/Currency/CurrencyHinekorasLock",
  "Armourer's Scrap": "Metadata/Items/Currency/CurrencyArmourQuality",
  "Blacksmith's Whetstone": "Metadata/Items/Currency/CurrencyWeaponQuality",
  "Glassblower's Bauble": "Metadata/Items/Currency/CurrencyFlaskQuality",
  "Gemcutter's Prism": "Metadata/Items/Currency/CurrencyGemQuality",
};

export function isFaustusTradeable(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FAUSTUS_NAME_TO_ID, name);
}

interface ExchangeMarket {
  league: string;
  market_pair: [string, string];
  volume_traded: Record<string, number>;
  lowest_ratio: Record<string, number>;
  highest_ratio: Record<string, number>;
}

interface CacheEntry {
  data: ExchangeMarket[];
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * The endpoint's own docs say responses are "purely historical" - there isn't any way to get data
 * from the current, still-open hour - and that an omitted id defaults to the FIRST retained hour
 * (2024-era, verified during development), not the most recent one. Two hours back is comfortably
 * inside a fully-closed hour while staying as fresh as the endpoint allows.
 */
async function fetchExchangeMarkets(league: string): Promise<ExchangeMarket[]> {
  const cached = cache.get(league);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const hourTimestamp = Math.floor(Date.now() / 1000 / 3600) * 3600 - 2 * 3600;
  try {
    const res = await fetch(`${EXCHANGE_URL}/${hourTimestamp}`, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) {
      console.warn(`GGG currency-exchange request failed (${res.status})`);
      return cached?.data ?? [];
    }
    const data = (await res.json()) as { markets?: ExchangeMarket[] };
    const markets = (data.markets ?? []).filter((m) => m.league === league);
    cache.set(league, { data: markets, expiresAt: Date.now() + CACHE_TTL_MS });
    return markets;
  } catch (err) {
    console.warn("GGG currency-exchange request errored:", err);
    return cached?.data ?? [];
  }
}

/** Chaos-per-unit rate for `id`, using the pair's ratio midpoint - undefined if `id` isn't one side of this pair. */
function rateFromPair(market: ExchangeMarket, id: string, chaosSideId: string): number | undefined {
  if (!market.market_pair.includes(id) || !market.market_pair.includes(chaosSideId)) return undefined;
  const idLow = market.lowest_ratio[id];
  const idHigh = market.highest_ratio[id];
  const chaosLow = market.lowest_ratio[chaosSideId];
  const chaosHigh = market.highest_ratio[chaosSideId];
  if (!idLow || !idHigh || !chaosLow || !chaosHigh) return undefined;
  return (chaosLow / idHigh + chaosHigh / idLow) / 2;
}

export interface FaustusPrice {
  chaosValue: number;
  /** Undefined only if Divine Orb itself had no computable rate this hour. */
  divineValue?: number;
}

/**
 * Every FAUSTUS_NAME_TO_ID entry this league's exchange data can actually price, in one shot - one
 * fetch (cached) covers every name, since the whole mapped set is small. Prefers, per name, whichever
 * pair (against Chaos or against Divine, converted) saw the most trade volume that hour, so a
 * thinly-traded coincidental pairing doesn't win over the real market.
 */
export async function getFaustusPrices(league: string): Promise<Map<string, FaustusPrice>> {
  const markets = await fetchExchangeMarkets(league);
  const result = new Map<string, FaustusPrice>();
  if (markets.length === 0) return result;

  let divineChaosRate: number | undefined;
  for (const m of markets) {
    const rate = rateFromPair(m, DIVINE_ID, CHAOS_ID);
    if (rate !== undefined) {
      divineChaosRate = rate;
      break;
    }
  }

  for (const [name, id] of Object.entries(FAUSTUS_NAME_TO_ID)) {
    // Chaos Orb is the pivot currency - it never forms a pair with itself, so it has to be special-cased.
    if (id === CHAOS_ID) {
      result.set(name, { chaosValue: 1, divineValue: divineChaosRate ? 1 / divineChaosRate : undefined });
      continue;
    }
    let best: { chaosValue: number; volume: number } | undefined;
    for (const m of markets) {
      const volume = m.volume_traded[id] ?? 0;
      const viaChaos = rateFromPair(m, id, CHAOS_ID);
      const viaDivine = divineChaosRate !== undefined ? rateFromPair(m, id, DIVINE_ID) : undefined;
      const chaosValue = viaChaos ?? (viaDivine !== undefined ? viaDivine * divineChaosRate! : undefined);
      if (chaosValue !== undefined && (!best || volume > best.volume)) {
        best = { chaosValue, volume };
      }
    }
    if (best) {
      result.set(name, {
        chaosValue: best.chaosValue,
        divineValue: divineChaosRate ? best.chaosValue / divineChaosRate : undefined,
      });
    }
  }
  return result;
}

/** Single-name convenience wrapper for the on-demand "Faustus Price" button - still goes through
 *  the same cached, whole-league computation above rather than re-fetching per click. */
export async function getFaustusPrice(name: string, league: string): Promise<FaustusPrice | undefined> {
  if (!isFaustusTradeable(name)) return undefined;
  const prices = await getFaustusPrices(league);
  return prices.get(name);
}
