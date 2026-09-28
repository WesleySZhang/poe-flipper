import type { TradeItem, TradeListing, TradeMod } from "./trade-api";

/**
 * The sold listing tracker's data model and rules - shared by the tracker
 * (scripts/track-sold-listings.ts, which owns the loop and the API calls) and the Sold Listings page
 * (lib/sold-listings.ts reads the published file). Pure, so components can import its types.
 *
 * A listing is followed by its item id, which the trade site uses as the listing id and keeps when
 * the price changes (tested 2026-09-28: 100d -> 50d kept the id). So a price drop - even below the
 * tracker's floor - is a price change, not a sale. A listing counts as sold only when fetching its id
 * returns nothing for SOLD_AFTER_MISSING_HOURS; if it comes back after that (relisted), it's reopened.
 * The one false positive left: an item taken off the market for good looks the same as a sale.
 */
export const SOLD_TRACKER_MIN_DIVINES = 100;
/** How long a listing must be gone before it counts as sold - long enough for a relist to show up. */
export const SOLD_AFTER_MISSING_HOURS = 24;
/** A listing still up this long after it was listed is recorded as unsold and no longer checked. */
export const LISTING_MAX_AGE_DAYS = 7;
// Hourly: the fetch limit (~1,170 listings an hour at lib/trade-api.ts's margin) then covers about
// 1,000 tracked listings. Past that, checks fall behind (most overdue first) rather than failing.
export const RECHECK_LISTED_MINUTES = 60;
export const RECHECK_MISSING_MINUTES = 120;
export const DISCOVERY_MINUTES = 30;
export const MIN_DISCOVERY_MINUTES = 5;
/** A search returns at most this many ids (newest first here), so a run that finds this many new
 *  listings has likely missed some. */
export const SEARCH_RESULT_CAP = 100;

const HOUR_MS = 60 * 60 * 1000;

export type ListingStatus = "listed" | "sold" | "unsold";

export interface ListingPrice {
  amount: number;
  currency: string;
  /** ISO time the tracker first saw this price. */
  at: string;
}

export interface SoldListingItem {
  name?: string;
  typeLine: string;
  baseType?: string;
  rarity?: string;
  ilvl?: number;
  icon?: string;
  corrupted?: boolean;
  mutated?: boolean;
  /** Enchants and implicits, in game order. */
  implicits: string[];
  /** Fractured, explicit and crafted mods, in game order; crafted/fractured ones say so. */
  mods: string[];
}

export interface TrackedListing {
  /** The item's id - also its listing id on the trade site. */
  id: string;
  /** Labels of the searches (lib/trade-query.ts links) that found it. */
  searches: string[];
  item: SoldListingItem;
  /** Every price seen, oldest first. The last one is the current (or final) price. */
  prices: ListingPrice[];
  /** When it was listed: the trade site's `indexed` time when the tracker first saw it. `indexed`
   *  resets on every price change, so later values aren't kept. */
  listedAt: string;
  firstSeen: string;
  lastSeen: string;
  lastChecked: string;
  /** First check that found it gone, while it's gone. */
  missingSince?: string;
  status: ListingStatus;
  /** Sold: when it was first found gone. Unsold: when it reached LISTING_MAX_AGE_DAYS. */
  endedAt?: string;
  /** It was counted sold once, then showed up listed again. */
  reappeared?: boolean;
}

export interface TrackedSearchStatus {
  label: string;
  /** The link as written in sold-tracker/searches.md. */
  url: string;
  lastRun?: string;
  /** Listings matching the search (with the tracker's rules) at the last run. */
  total?: number;
  /** New listings found at the last run. */
  newListings?: number;
  /** The last run found SEARCH_RESULT_CAP new listings, so it likely missed some. */
  missedListings?: boolean;
  /** Minutes until the next run - shortened when a search gets busy. */
  intervalMinutes?: number;
  error?: string;
}

/** The tracker's whole state, and the file the page reads (sold-listings/<League>.json). */
export interface SoldTrackerFile {
  version: 1;
  league: string;
  updatedAt: string;
  minDivines: number;
  searches: TrackedSearchStatus[];
  listings: TrackedListing[];
}

export function emptyTrackerFile(league: string): SoldTrackerFile {
  return { version: 1, league, updatedAt: new Date(0).toISOString(), minDivines: SOLD_TRACKER_MIN_DIVINES, searches: [], listings: [] };
}

function modText(mod: TradeMod): string | undefined {
  return typeof mod === "string" ? mod : mod.description;
}

function modList(mods: TradeMod[] | undefined, suffix = ""): string[] {
  return (mods ?? []).flatMap((m) => {
    const text = modText(m);
    return text ? [text + suffix] : [];
  });
}

export function toListingItem(item: TradeItem): SoldListingItem {
  return {
    ...(item.name ? { name: item.name } : {}),
    typeLine: item.typeLine ?? item.baseType ?? "",
    ...(item.baseType ? { baseType: item.baseType } : {}),
    ...(item.rarity ? { rarity: item.rarity } : {}),
    ...(item.ilvl !== undefined ? { ilvl: item.ilvl } : {}),
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.corrupted ? { corrupted: true } : {}),
    ...(item.mutated ? { mutated: true } : {}),
    implicits: [...modList(item.enchantMods, " (enchant)"), ...modList(item.implicitMods)],
    mods: [...modList(item.fracturedMods, " (fractured)"), ...modList(item.explicitMods), ...modList(item.craftedMods, " (crafted)")],
  };
}

/** The listing's current (or final) price. */
export function currentPrice(t: TrackedListing): ListingPrice | undefined {
  return t.prices[t.prices.length - 1];
}

/**
 * Records a fetched listing: adds it, or refreshes one already tracked (a new price is appended,
 * and a listing that was gone or counted sold is back). `searchLabel` is set when a search found it.
 */
export function recordListing(listings: Map<string, TrackedListing>, fetched: TradeListing, now: string, searchLabel?: string): TrackedListing {
  const existing = listings.get(fetched.id);
  const price = fetched.listing.price;
  if (!existing) {
    const t: TrackedListing = {
      id: fetched.id,
      searches: searchLabel ? [searchLabel] : [],
      item: toListingItem(fetched.item),
      prices: price ? [{ amount: price.amount, currency: price.currency, at: now }] : [],
      listedAt: fetched.listing.indexed,
      firstSeen: now,
      lastSeen: now,
      lastChecked: now,
      status: "listed",
    };
    listings.set(t.id, t);
    return t;
  }
  if (searchLabel && !existing.searches.includes(searchLabel)) existing.searches.push(searchLabel);
  const last = currentPrice(existing);
  if (price && (!last || last.amount !== price.amount || last.currency !== price.currency)) {
    existing.prices.push({ amount: price.amount, currency: price.currency, at: now });
  }
  existing.item = toListingItem(fetched.item);
  existing.lastSeen = now;
  existing.lastChecked = now;
  delete existing.missingSince;
  if (existing.status === "sold") {
    existing.status = "listed";
    existing.reappeared = true;
    delete existing.endedAt;
  }
  return existing;
}

/** A fetch by id came back empty. */
export function recordMissing(t: TrackedListing, now: string) {
  t.lastChecked = now;
  t.missingSince ??= now;
}

/** Moves listings that have been gone long enough to sold, and ones listed too long to unsold. */
export function settleListings(listings: Iterable<TrackedListing>, now: string) {
  const nowMs = Date.parse(now);
  for (const t of listings) {
    if (t.status !== "listed") continue;
    if (t.missingSince && nowMs - Date.parse(t.missingSince) >= SOLD_AFTER_MISSING_HOURS * HOUR_MS) {
      t.status = "sold";
      t.endedAt = t.missingSince;
    } else if (!t.missingSince && nowMs - Date.parse(t.listedAt) >= LISTING_MAX_AGE_DAYS * 24 * HOUR_MS) {
      t.status = "unsold";
      t.endedAt = now;
    }
  }
}

/** Listed ids due a check, most overdue first. */
export function listingsDueForCheck(listings: Iterable<TrackedListing>, now: string, limit: number): string[] {
  const nowMs = Date.parse(now);
  const due: Array<{ id: string; overdueMs: number }> = [];
  for (const t of listings) {
    if (t.status !== "listed") continue;
    const everyMs = (t.missingSince ? RECHECK_MISSING_MINUTES : RECHECK_LISTED_MINUTES) * 60 * 1000;
    const overdueMs = nowMs - Date.parse(t.lastChecked) - everyMs;
    if (overdueMs >= 0) due.push({ id: t.id, overdueMs });
  }
  return due
    .sort((a, b) => b.overdueMs - a.overdueMs)
    .slice(0, limit)
    .map((d) => d.id);
}

/** How long it was listed: from listing to first found gone (sold) or to now/expiry. */
export function listedDurationMs(t: TrackedListing, now: string): number {
  return Date.parse(t.endedAt ?? now) - Date.parse(t.listedAt);
}
