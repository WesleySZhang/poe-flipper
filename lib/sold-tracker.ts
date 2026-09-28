import type { TradeItem, TradeListing, TradeMod } from "./trade-api";

/**
 * The sold listing tracker's data model and rules - shared by the tracker
 * (scripts/track-sold-listings.ts, which owns the loop and the API calls) and the Sold Listings page
 * (lib/sold-listings.ts reads the published file). Pure, so components can import its types.
 *
 * A listing is followed by its item id, which the trade site uses as the listing id and keeps when
 * the price changes (tested 2026-09-28: 100d -> 50d kept the id). So a price drop - even out of the
 * search's own price range - is a price change, not a sale. A listing counts as sold once fetching
 * its id has returned nothing for SOLD_AFTER_MISSING_HOURS; if it comes back after that (relisted),
 * it's reopened. The one false positive left: an item taken off the market for good looks the same
 * as a sale.
 *
 * The tracker runs ~5.5 hours every 6 hours (the "Track sold listings" workflow) and checks every
 * listed listing once per run, so times (sold, how long it was up) are accurate to about 6 hours.
 */
/**
 * Limits on how much the tracker takes in, set by the trade site's fetch limit: 1,000 fetches (of 10
 * listings each) per 6 hours, of which lib/trade-api.ts uses 70% - ~7,000 listing checks per 6
 * hours. Checking every listing each 6 hours, plus fetching new ones, fits ~6,750; the cap leaves
 * room for GitHub's late starts. Enforced twice, from these same numbers:
 *  - before merge: scripts/check-sold-searches.ts (the "Check sold tracker searches" PR check) runs
 *    every search and fails if one matches more than MAX_LISTINGS_PER_SEARCH, the searches together
 *    more than MAX_TRACKED_LISTINGS, or there are more than MAX_SEARCHES;
 *  - while running (the market can grow after a search was approved, e.g. at a league start):
 *    admitNewListings below pauses an oversized search and stops taking new listings at capacity.
 */
export const MAX_TRACKED_LISTINGS = 6000;
export const MAX_LISTINGS_PER_SEARCH = 3000;
/** Each search costs up to 2 trade searches per discovery (see scripts/track-sold-listings.ts). */
export const MAX_SEARCHES = 20;
/** How long a listing must be gone before it counts as sold - long enough for a relist to show up
 *  (about three 6-hourly checks in a row). */
export const SOLD_AFTER_MISSING_HOURS = 12;
/** A listing still up this long after it was listed is recorded as unsold and no longer checked. */
export const LISTING_MAX_AGE_DAYS = 7;
// Once per run: a listing checked early in a 5.5-hour run isn't due again until the next run.
export const RECHECK_LISTED_MINUTES = 330;
export const RECHECK_MISSING_MINUTES = 330;
/** Fetches are spread over the run instead of spent at full speed: ~6,000 listings' 600-odd fetches
 *  take ~4.3 hours at this pace, and GGG's servers see a steady trickle rather than bursts. */
export const FETCH_PACE_MS = 25_000;
export const DISCOVERY_MINUTES = 30;
export const MIN_DISCOVERY_MINUTES = 5;
/** Ended listings stay in the tracker's state this long (so a relist is recognised), then live
 *  only in the archive. */
export const STATE_KEEP_ENDED_DAYS = 7;
/** What the page's file holds: sales from the last SOLD_PAGE_DAYS, unsold from the last
 *  UNSOLD_PAGE_DAYS, and listings gone but not yet counted sold. Everything is in the archive. */
export const SOLD_PAGE_DAYS = 30;
export const UNSOLD_PAGE_DAYS = 7;
/** A search returns at most this many ids (newest first here), so a run that finds this many new
 *  listings has likely missed some. */
export const SEARCH_RESULT_CAP = 100;
/** A search's `total` stops counting here. */
export const TRADE_TOTAL_CAP = 10000;

/** A search's listing count, as "10,000+" when the trade site stopped counting. */
export function formatSearchTotal(total: number): string {
  return total >= TRADE_TOTAL_CAP ? `${TRADE_TOTAL_CAP.toLocaleString("en-US")}+` : total.toLocaleString("en-US");
}

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
  /** The last run found more new listings than it could fetch (see scripts/track-sold-listings.ts). */
  missedListings?: boolean;
  /** Minutes until the next run - shortened when a search gets busy. */
  intervalMinutes?: number;
  error?: string;
  /** Why it isn't taking new listings: over MAX_LISTINGS_PER_SEARCH, or past MAX_SEARCHES. Its
   *  listings already tracked are still checked. */
  paused?: string;
}

/**
 * The tracker's own state (state/<League>.json on the sold-tracker-data branch): every listed listing,
 * plus ended ones from the last STATE_KEEP_ENDED_DAYS. Ended listings are also appended to the
 * archive (ended/<League>/<YYYY-MM>.jsonl, one listing per line; a relisted one that ends again
 * appears twice - the later line wins).
 */
export interface TrackerState {
  version: 2;
  league: string;
  updatedAt: string;
  /** The tracker was at MAX_TRACKED_LISTINGS at its last save, so new listings were being skipped. */
  atCapacity?: boolean;
  searches: TrackedSearchStatus[];
  listings: TrackedListing[];
}

/** The file the Sold Listings page reads (sold-listings/<League>.json) - a slice of the state small
 *  enough to download whole: see SOLD_PAGE_DAYS. */
export interface SoldListingsFile {
  version: 2;
  league: string;
  updatedAt: string;
  atCapacity?: boolean;
  /** Listings being followed right now. */
  trackedCount: number;
  searches: TrackedSearchStatus[];
  listings: TrackedListing[];
}

export function emptyTrackerState(league: string): TrackerState {
  return { version: 2, league, updatedAt: new Date(0).toISOString(), searches: [], listings: [] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildSoldListingsFile(state: TrackerState, listings: Iterable<TrackedListing>, now: string): SoldListingsFile {
  const nowMs = Date.parse(now);
  const within = (iso: string | undefined, days: number) => iso !== undefined && nowMs - Date.parse(iso) <= days * DAY_MS;
  const page: TrackedListing[] = [];
  let trackedCount = 0;
  for (const t of listings) {
    if (t.status === "listed") trackedCount++;
    if (
      (t.status === "sold" && within(t.endedAt, SOLD_PAGE_DAYS)) ||
      (t.status === "unsold" && within(t.endedAt, UNSOLD_PAGE_DAYS)) ||
      (t.status === "listed" && t.missingSince)
    ) {
      page.push(t);
    }
  }
  return {
    version: 2,
    league: state.league,
    updatedAt: now,
    ...(state.atCapacity ? { atCapacity: true } : {}),
    trackedCount,
    searches: state.searches,
    listings: page,
  };
}

/** Ended listings old enough to leave the state (they're already in the archive). */
export function endedToDrop(listings: Iterable<TrackedListing>, now: string): string[] {
  const nowMs = Date.parse(now);
  const out: string[] = [];
  for (const t of listings) {
    if (t.status !== "listed" && t.endedAt && nowMs - Date.parse(t.endedAt) > STATE_KEEP_ENDED_DAYS * DAY_MS) out.push(t.id);
  }
  return out;
}

/**
 * The runtime limits (see MAX_TRACKED_LISTINGS): which of a discovery run's new listings to take in.
 * A search matching more than MAX_LISTINGS_PER_SEARCH is paused - none taken - rather than trimmed,
 * so it's visibly flagged instead of quietly using the budget. Otherwise new listings are taken
 * until MAX_TRACKED_LISTINGS listings are being followed.
 */
export function admitNewListings(
  freshIds: string[],
  searchTotal: number,
  listedCount: number
): { admit: string[]; paused?: string; atCapacity: boolean } {
  if (searchTotal > MAX_LISTINGS_PER_SEARCH) {
    return {
      admit: [],
      paused: `Matches ${formatSearchTotal(searchTotal)} listings, over the ${MAX_LISTINGS_PER_SEARCH} limit - narrow it`,
      atCapacity: listedCount >= MAX_TRACKED_LISTINGS,
    };
  }
  const room = Math.max(0, MAX_TRACKED_LISTINGS - listedCount);
  return { admit: freshIds.slice(0, room), atCapacity: freshIds.length > room || listedCount >= MAX_TRACKED_LISTINGS };
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

/** Moves listings that have been gone long enough to sold, and ones listed too long to unsold.
 *  Returns the ones that ended, for the archive. */
export function settleListings(listings: Iterable<TrackedListing>, now: string): TrackedListing[] {
  const nowMs = Date.parse(now);
  const ended: TrackedListing[] = [];
  for (const t of listings) {
    if (t.status !== "listed") continue;
    if (t.missingSince && nowMs - Date.parse(t.missingSince) >= SOLD_AFTER_MISSING_HOURS * HOUR_MS) {
      t.status = "sold";
      t.endedAt = t.missingSince;
      ended.push(t);
    } else if (!t.missingSince && nowMs - Date.parse(t.listedAt) >= LISTING_MAX_AGE_DAYS * 24 * HOUR_MS) {
      t.status = "unsold";
      t.endedAt = now;
      ended.push(t);
    }
  }
  return ended;
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
