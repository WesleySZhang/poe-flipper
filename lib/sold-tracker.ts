import type { TradeItem, TradeListing, TradeMod, TradeProperty } from "./trade-api";

/**
 * The sold listing tracker's data model and rules - shared by the tracker
 * (scripts/track-sold-listings.ts, which owns the loop and the API calls) and the Sold Listings page
 * (lib/sold-listings.ts reads the published file). Pure, so components can import its types.
 *
 * A listing is followed by its item id, which the trade site uses as the listing id and keeps when
 * the price changes (tested 2026-09-28: 100d -> 50d kept the id). So a price drop - even out of the
 * search's own price range - is a price change, not a sale (repricing happens in place). A listing
 * counts as sold at the first check that finds it gone - pulling an item only to relist it later is
 * rare; if one does come back, it's reopened and marked relisted. The false positive left: an item
 * taken off the market for good looks the same as a sale.
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
/** A listing still up this long after it was listed is recorded as unsold and no longer checked. */
export const LISTING_MAX_AGE_DAYS = 7;
// Once per run: a listing checked early in a 5.5-hour run isn't due again until the next run.
export const RECHECK_LISTED_MINUTES = 330;
/** Fetches are spread over the run instead of spent at full speed: ~6,000 listings' 600-odd fetches
 *  take ~4.3 hours at this pace, and GGG's servers see a steady trickle rather than bursts. */
export const FETCH_PACE_MS = 25_000;
export const DISCOVERY_MINUTES = 30;
export const MIN_DISCOVERY_MINUTES = 5;
/** Ended listings stay in the tracker's state this long (so a relist is recognised), then live
 *  only in the archive. */
export const STATE_KEEP_ENDED_DAYS = 7;
/** What the page's file holds: sales from the last SOLD_PAGE_DAYS, unsold from the last
 *  UNSOLD_PAGE_DAYS, and every listing still up (the page counts those as unsold). Everything
 *  ended is in the archive. */
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
  /** The note's prefix, "~b/o" or "~price". */
  type?: string;
  /** ISO time the tracker first saw this price. */
  at: string;
}

export type ListingModKind = "enchant" | "implicit" | "fractured" | "explicit" | "crafted" | "crucible" | "scourge";

/** One mod line, with the roll range of each number in it (in order) when the trade site gives one. */
export interface ListingMod {
  kind: ListingModKind;
  text: string;
  ranges?: Array<{ min: number; max: number }>;
  /** Mod tier, 1 = best (magic/rare mods only - uniques have none). */
  tier?: number;
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
  /** Enchants and implicits, in game order - the table's short form. */
  implicits: string[];
  /** Fractured, explicit and crafted mods, in game order; crafted/fractured ones say so. */
  mods: string[];
  /** Everything else about this exact item, for the page's detail view. Missing on listings the
   *  tracker saw before it recorded details (filled in at their next check). */
  detail?: SoldListingDetail;
}

export interface SoldListingDetail {
  /** "Limited to: 1", "Quality: +20%", ... in the order the game shows them. */
  properties: string[];
  requirements: string[];
  /** e.g. "R-G-B B" - linked sockets joined by "-". */
  sockets?: string;
  /** Shaper, Elder, Crusader, ... and Mirrored, Fractured, Synthesised, Split, Relic, Foil (...). */
  tags: string[];
  /** Every mod, in game order, with roll ranges. */
  mods: ListingMod[];
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
  status: ListingStatus;
  /** Sold: the check that found it gone (it sold between lastSeen and this). Unsold: when it
   *  reached LISTING_MAX_AGE_DAYS. */
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
 * archive (ended/<League>/<YYYY-MM-DD>.jsonl by the day each ended, one listing per line; a relisted one that ends again
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
      t.status === "listed" ||
      (t.status === "sold" && within(t.endedAt, SOLD_PAGE_DAYS)) ||
      (t.status === "unsold" && within(t.endedAt, UNSOLD_PAGE_DAYS))
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

/** The game's text markup, "[Ref|Shown text]" or "[Text]", as the text the game shows. */
export function stripGameMarkup(text: string): string {
  return text.replace(/\[([^\]|]*)\|([^\]]*)\]/g, "$2").replace(/\[([^\]|]*)\]/g, "$1");
}

function modText(mod: TradeMod): string | undefined {
  const text = typeof mod === "string" ? mod : mod.description;
  return text && stripGameMarkup(text);
}

function modList(mods: TradeMod[] | undefined, suffix = ""): string[] {
  return (mods ?? []).flatMap((m) => {
    const text = modText(m);
    return text ? [text + suffix] : [];
  });
}

function modRanges(mod: TradeMod): Array<{ min: number; max: number }> | undefined {
  if (typeof mod === "string") return undefined;
  const ranges = (mod.mods ?? []).flatMap((m) =>
    (m.magnitudes ?? []).flatMap((g) => {
      const min = Number(g.min);
      const max = Number(g.max);
      return Number.isFinite(min) && Number.isFinite(max) ? [{ min: Math.min(min, max), max: Math.max(min, max) }] : [];
    })
  );
  return ranges.length > 0 ? ranges : undefined;
}

/** "P7" / "S2" -> 7 / 2. A hybrid mod's parts share one tier, so the first is enough. */
function modTier(mod: TradeMod): number | undefined {
  if (typeof mod === "string") return undefined;
  const match = mod.mods?.find((m) => m.tier)?.tier?.match(/(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

const MOD_KINDS: Array<[ListingModKind, keyof TradeItem]> = [
  ["enchant", "enchantMods"],
  ["implicit", "implicitMods"],
  ["fractured", "fracturedMods"],
  ["explicit", "explicitMods"],
  ["crafted", "craftedMods"],
  ["crucible", "crucibleMods"],
  ["scourge", "scourgeMods"],
];

/** "Limited to: 1", or a name with {0} placeholders filled in ("Radius: {0}"). */
function propertyText(p: TradeProperty): string {
  const name = stripGameMarkup(p.name);
  const values = (p.values ?? []).map((v) => v[0]);
  if (name.includes("{0}")) return values.reduce((text, v, i) => text.replace(`{${i}}`, v), name);
  return values.length > 0 ? `${name}: ${values.join(", ")}` : name;
}

/** Base64 -> UTF-8, in both Node and the browser (this module is shared). */
function decodeBase64(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The item text (base64 in the fetch) is read only for the foil name, not stored: at ~1.7 KB it was
 * half of each stored listing. Flavour text isn't stored either - nothing shows it.
 */
function toListingDetail(item: TradeItem): SoldListingDetail {
  const text = item.extended?.text ? decodeBase64(item.extended.text).replace(/\r\n/g, "\n").trim() : undefined;
  const tags = [
    ...Object.entries(item.influences ?? {})
      .filter(([, on]) => on)
      .map(([name]) => name[0].toUpperCase() + name.slice(1)),
    ...(item.fractured ? ["Fractured"] : []),
    ...(item.synthesised ? ["Synthesised"] : []),
    ...(item.mirrored ? ["Mirrored"] : []),
    ...(item.split ? ["Split"] : []),
    ...(item.isRelic ? ["Relic"] : []),
  ];
  // The foil's name ("Celestial Emerald") is only in the item text: "Foil Unique (Celestial Emerald)".
  const foil = text?.match(/^Foil Unique \((.+)\)$/m)?.[1];
  if (foil) tags.push(`Foil: ${foil}`);
  const groups = new Map<number, string[]>();
  for (const s of item.sockets ?? []) groups.set(s.group, [...(groups.get(s.group) ?? []), s.sColour ?? "?"]);
  return {
    properties: (item.properties ?? []).map(propertyText),
    requirements: (item.requirements ?? []).map(propertyText),
    ...(groups.size > 0 ? { sockets: [...groups.values()].map((g) => g.join("-")).join(" ") } : {}),
    tags,
    mods: MOD_KINDS.flatMap(([kind, key]) =>
      ((item[key] as TradeMod[] | undefined) ?? []).flatMap((m) => {
        const t = modText(m);
        const ranges = modRanges(m);
        const tier = modTier(m);
        return t ? [{ kind, text: t, ...(ranges ? { ranges } : {}), ...(tier !== undefined ? { tier } : {}) }] : [];
      })
    ),
  };
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
    detail: toListingDetail(item),
  };
}

/** Drops what older tracker versions stored but nothing reads (item text, flavour text). */
export function dropUnusedDetail(t: TrackedListing): TrackedListing {
  const detail = t.item.detail as (SoldListingDetail & { text?: string; flavourText?: string }) | undefined;
  if (detail) {
    delete detail.text;
    delete detail.flavourText;
  }
  return t;
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
      prices: price ? [{ amount: price.amount, currency: price.currency, ...(price.type ? { type: price.type } : {}), at: now }] : [],
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
    existing.prices.push({ amount: price.amount, currency: price.currency, ...(price.type ? { type: price.type } : {}), at: now });
  }
  existing.item = toListingItem(fetched.item);
  existing.lastSeen = now;
  existing.lastChecked = now;
  if (existing.status === "sold") {
    existing.status = "listed";
    existing.reappeared = true;
    delete existing.endedAt;
  }
  return existing;
}

/** A fetch by id came back empty: it sold (see the module doc). Returns it, for the archive. */
export function recordMissing(t: TrackedListing, now: string): TrackedListing {
  t.lastChecked = now;
  t.status = "sold";
  t.endedAt = now;
  return t;
}

/** Moves listings still up LISTING_MAX_AGE_DAYS after listing to unsold. Returns them, for the
 *  archive. */
export function settleListings(listings: Iterable<TrackedListing>, now: string): TrackedListing[] {
  const nowMs = Date.parse(now);
  const ended: TrackedListing[] = [];
  for (const t of listings) {
    if (t.status !== "listed") continue;
    if (nowMs - Date.parse(t.listedAt) >= LISTING_MAX_AGE_DAYS * 24 * HOUR_MS) {
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
    const everyMs = RECHECK_LISTED_MINUTES * 60 * 1000;
    const overdueMs = nowMs - Date.parse(t.lastChecked) - everyMs;
    if (overdueMs >= 0) due.push({ id: t.id, overdueMs });
  }
  return due
    .sort((a, b) => b.overdueMs - a.overdueMs)
    .slice(0, limit)
    .map((d) => d.id);
}

/** How long it was listed: from listing to found gone (sold) or to now/expiry. */
export function listedDurationMs(t: TrackedListing, now: string): number {
  return Date.parse(t.endedAt ?? now) - Date.parse(t.listedAt);
}

/** Each price the listing had and how long it stayed at it: the first from the listing time, each
 *  later one from when the tracker first saw it, the last until it sold/expired (or `now`). */
export function priceSpans(t: TrackedListing, now: string): Array<{ price: ListingPrice; durationMs: number; current: boolean }> {
  const end = Date.parse(t.endedAt ?? now);
  return t.prices.map((price, i) => {
    const from = i === 0 ? Math.min(Date.parse(t.listedAt), Date.parse(price.at)) : Date.parse(price.at);
    const to = i + 1 < t.prices.length ? Date.parse(t.prices[i + 1].at) : end;
    return { price, durationMs: Math.max(0, to - from), current: i === t.prices.length - 1 };
  });
}
