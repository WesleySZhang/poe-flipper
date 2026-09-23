import {
  getAllCurrentCurrencyPrices,
  getAllCurrentItemPrices,
  type CurrencyOverviewType,
  type CurrencyPrice,
  type ItemPrice,
} from "./poe-ninja";

/**
 * A once-a-day snapshot of poe.ninja's whole live price map, published by the daily precompute job
 * (scripts/precompute-price-snapshot.ts -> the "data" branch's prices.json) and read back here, so
 * the running app stops calling poe.ninja (~48 requests per cold server instance) for data that
 * doesn't need to be fresher than the predictions themselves already are - those are computed once
 * a day from the same prices, so showing a live sparkline/price next to a day-old forecast was
 * never actually more correct, just less consistent.
 *
 * Same overall shape as lib/precomputed-predictions.ts (raw GitHub file, short in-memory cache, a
 * validity check, never throws - `undefined` means "no usable snapshot", and every caller falls back
 * to fetching live from poe.ninja exactly as before).
 *
 * Deliberately NOT used by lib/divination-flips.ts (a live profit calculation) or lib/flip-
 * suggestions.ts's live fallback; those keep live prices, but use getActiveTypes below to skip
 * categories that had no listings at snapshot time.
 */

// Compact keys - this holds ~24k items, and it's read whole on every cold server instance.
interface SnapshotCurrency {
  c: number; // chaosValue
  t: CurrencyOverviewType;
  s?: Array<number | null>; // spark
}
interface SnapshotItem {
  c: number;
  t: string;
  n?: number; // sellerCount
  s?: Array<number | null>;
}

export interface PriceSnapshot {
  league: string;
  /** ISO timestamp of when the daily job fetched these prices. */
  fetchedAt: string;
  currency: Record<string, SnapshotCurrency>;
  items: Record<string, SnapshotItem>;
  /** Category buckets that had at least one line at fetchedAt - see getActiveTypes. */
  activeCurrencyTypes: string[];
  activeItemTypes: string[];
}

const DEFAULT_REPO = "WesleySZhang/poe-flipper";
const DATA_BRANCH = "data";
const DATA_FILE_PATH = "prices.json";
const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
// The daily job runs at 00:10 UTC; anything older than this means it missed a run (or several), and
// serving those prices would be worse than just fetching live.
const MAX_SNAPSHOT_AGE_MS = 36 * 60 * 60 * 1000;
// The file changes once a day and is multi-MB, so unlike precomputed-predictions.ts's 2 minutes this is
// held for half an hour - a freshly-published day is picked up within that, well inside MAX_SNAPSHOT_AGE_MS.
const CACHE_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  data: PriceSnapshot | null;
  expiresAt: number;
}
let cache: CacheEntry | undefined;
let inFlight: Promise<PriceSnapshot | null> | undefined;

function isPriceSnapshot(value: unknown): value is PriceSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PriceSnapshot>;
  return (
    typeof v.league === "string" &&
    typeof v.fetchedAt === "string" &&
    !!v.currency &&
    typeof v.currency === "object" &&
    !!v.items &&
    typeof v.items === "object" &&
    Array.isArray(v.activeCurrencyTypes) &&
    Array.isArray(v.activeItemTypes)
  );
}

async function fetchSnapshot(): Promise<PriceSnapshot | null> {
  if (cache && cache.expiresAt > Date.now()) return cache.data;
  // Concurrent callers (item-detail fires several requests at once) share one download.
  inFlight ??= (async () => {
    let data: PriceSnapshot | null = null;
    try {
      const repo = process.env.PREDICTIONS_REPO ?? DEFAULT_REPO;
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${DATA_BRANCH}/${DATA_FILE_PATH}`, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (res.ok) {
        const parsed: unknown = await res.json();
        if (isPriceSnapshot(parsed)) data = parsed;
      }
    } catch {
      // Network error / malformed JSON - callers fall back to live poe.ninja.
    }
    cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
    inFlight = undefined;
    return data;
  })();
  return inFlight;
}

/** Today's usable snapshot for `league`, or undefined (missing, wrong league, or too old). */
export async function getPriceSnapshot(league: string): Promise<PriceSnapshot | undefined> {
  const data = await fetchSnapshot();
  if (!data || data.league !== league) return undefined;
  if (Date.now() - Date.parse(data.fetchedAt) > MAX_SNAPSHOT_AGE_MS) return undefined;
  return data;
}

/** Non-empty category buckets per the last snapshot - pass to getAllCurrent*Prices's `activeTypes`
 *  so a live fetch skips buckets that had no listings (about a quarter of all requests). Both
 *  undefined when there's no usable snapshot, which means "request everything", as before. */
export async function getActiveTypes(league: string): Promise<{ currency?: string[]; item?: string[] }> {
  const snapshot = await getPriceSnapshot(league);
  return snapshot ? { currency: snapshot.activeCurrencyTypes, item: snapshot.activeItemTypes } : {};
}

// Expanding ~24k records into Maps on every request would cost more than the lookup itself - built
// once per downloaded snapshot object instead (a fresh download is a new object, so it rebuilds).
const currencyMaps = new WeakMap<PriceSnapshot, Map<string, CurrencyPrice>>();
const itemMaps = new WeakMap<PriceSnapshot, Map<string, ItemPrice>>();

/** Snapshot prices if there's a usable snapshot, else a live poe.ninja fetch. */
export async function getCurrencyPricesPreferSnapshot(league: string): Promise<Map<string, CurrencyPrice>> {
  const snapshot = await getPriceSnapshot(league);
  if (!snapshot) return getAllCurrentCurrencyPrices(league);
  let map = currencyMaps.get(snapshot);
  if (!map) {
    map = new Map(Object.entries(snapshot.currency).map(([name, p]) => [name, { chaosValue: p.c, type: p.t, spark: p.s }]));
    currencyMaps.set(snapshot, map);
  }
  return map;
}

export async function getItemPricesPreferSnapshot(league: string): Promise<Map<string, ItemPrice>> {
  const snapshot = await getPriceSnapshot(league);
  if (!snapshot) return getAllCurrentItemPrices(league);
  let map = itemMaps.get(snapshot);
  if (!map) {
    map = new Map(Object.entries(snapshot.items).map(([key, p]) => [key, { chaosValue: p.c, type: p.t, sellerCount: p.n, spark: p.s }]));
    itemMaps.set(snapshot, map);
  }
  return map;
}

/** Builds the file's contents from already-fetched live price maps - used by the daily job. */
export function buildPriceSnapshot(
  league: string,
  currencyPrices: Map<string, CurrencyPrice>,
  itemPrices: Map<string, ItemPrice>,
  activeItemTypes: string[]
): PriceSnapshot {
  const currency: PriceSnapshot["currency"] = {};
  const activeCurrency = new Set<string>(["Currency", "Fragment"]); // always requested - see lib/poe-ninja.ts
  for (const [name, p] of currencyPrices) {
    currency[name] = { c: p.chaosValue, t: p.type, ...(p.spark ? { s: p.spark } : {}) };
    activeCurrency.add(p.type);
  }
  const items: PriceSnapshot["items"] = {};
  for (const [key, p] of itemPrices) {
    items[key] = {
      c: p.chaosValue,
      t: p.type,
      ...(p.sellerCount !== undefined ? { n: p.sellerCount } : {}),
      ...(p.spark ? { s: p.spark } : {}),
    };
  }
  return {
    league,
    fetchedAt: new Date().toISOString(),
    currency,
    items,
    activeCurrencyTypes: [...activeCurrency],
    activeItemTypes: activeItemTypes,
  };
}
