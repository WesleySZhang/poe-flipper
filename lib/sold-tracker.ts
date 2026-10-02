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
 * rare. If a sale comes back (a search shows it again, or the by-id re-check in its first
 * SOLD_RECHECK_DAYS finds it live), the seller decides: the same seller means it was pulled and
 * relisted - reopened, not a sale; a different seller means it sold and the buyer is reselling it -
 * the sale stands and the resale is tracked as its own listing. The false positive left: an item
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
/** What the page's file holds: sales from the last SOLD_PAGE_DAYS, unsold from the last
 *  UNSOLD_PAGE_DAYS, and every listing still up (the page counts those as unsold). Everything
 *  ended is in the archive. The page's file is built from the state, so ended listings stay in the
 *  state exactly as long (endedToDrop) - which is also how long a relist can be recognised. */
export const SOLD_PAGE_DAYS = 30;
export const UNSOLD_PAGE_DAYS = 7;
/** A sale is re-fetched by id every RECHECK_SOLD_MINUTES (every other run) for SOLD_RECHECK_DAYS
 *  after it, ~2 checks per sale, to catch a relist the searches don't show (e.g. relisted above a
 *  search's price range). Searches catch the rest for free, for as long as the sale is in the state. */
export const SOLD_RECHECK_DAYS = 1;
export const RECHECK_SOLD_MINUTES = 660;
/** Archive day files older than this are gzipped (`.jsonl.gz`, ~10x smaller). */
export const ARCHIVE_GZIP_DAYS = 30;
/** The run log warns when the archive passes this; see scripts/cull-sold-archive.ts. */
export const ARCHIVE_WARN_BYTES = 500 * 1024 * 1024;
/** A search returns at most this many ids (newest first here), so a run that finds this many new
 *  listings has likely missed some. */
export const SEARCH_RESULT_CAP = 100;
/** The sweep's page cap per search: MAX_LISTINGS_PER_SEARCH at 100 a page, plus room for price ties. */
export const SWEEP_MAX_PAGES = 40;
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
  /** "Jewels", "Body Armours", ... - the item text's first line; only there, not in the fetch's fields. */
  itemClass?: string;
  /** "Limited to: 1", "Quality: +10% (augmented)", ... in the order the game shows them, with the
   *  game's "(augmented)" after values changed by mods (lib/item-text.ts; the tooltip hides it). */
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
  /** The item's id - also its listing id on the trade site. A sale whose item was later resold is
   *  moved aside to `<item id>~<sold time ms>` (see `itemId`, `resoldAs`). */
  id: string;
  /** Set when `id` isn't the item id: a sale moved aside for its resale. */
  itemId?: string;
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
  /** It was counted sold once, then showed up listed again (by the same seller, or one we can't
   *  compare). Each time is in `relists`. */
  reappeared?: boolean;
  /** Each time it was counted sold, then came back from the same seller: a pull and relist. */
  relists?: Array<{ goneAt: string; backAt: string }>;
  /** A short hash of the seller's account name (sellerHash), from the last live fetch - only to tell
   *  "the same seller relisted it" from "a buyer resold it". Names aren't stored. */
  seller?: string;
  /** The `indexed` time at the last fetch (it resets on a price change, and on some moves). */
  lastIndexed?: string;
  /** `indexed` times that changed at an unchanged price - the seller moved or re-listed it in place.
   *  A weaker pull-and-relist signal; capped at MAX_TOUCHES. */
  touchedAt?: string[];
  /** This listing is the item listed again by a different seller after it sold: the id (key) of that
   *  earlier sale. */
  resaleOf?: string;
  /** On a sale: the item was listed again by a different seller (this item id). */
  resoldAs?: string;
}

const MAX_TOUCHES = 20;

/** A short, stable hash of a seller's account name (cyrb53) - enough to compare, keeps no names. */
export function sellerHash(name: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
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
  /** No longer in searches.md since this time (reconcileSearches). Kept while the page still shows
   *  any of its sold/unsold listings, so its chip can be shown as removed. */
  removed?: string;
}

/**
 * The tracker's own state (state/<League>.json on the sold-tracker-data branch): every listed listing,
 * plus sales from the last SOLD_PAGE_DAYS and unsold from the last UNSOLD_PAGE_DAYS. Ended listings
 * are also appended to the archive (ended/<League>/<YYYY-MM-DD>.jsonl by the day each ended, one
 * listing per line, gzipped after ARCHIVE_GZIP_DAYS). A listing can appear more than once - the
 * later line wins: a sale that's reopened (pulled and relisted) gets a line with status "listed"
 * when it comes back, and another when it ends again. A sale moved aside for a resale gets a line
 * under its new id (`<item id>~<ms>`, with `itemId`), so the resale's own lines don't replace it.
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

/** What /api/sold-listings returns: the file, plus each listing currency's chaos value right now
 *  (trade currency id -> chaos, from poe.ninja) so prices in different currencies sort together. */
export interface SoldListingsResponse extends SoldListingsFile {
  chaosRates?: Record<string, number>;
}

/** Trade site currency ids -> poe.ninja names, for chaosRates. Chaos is 1 by definition. */
export const TRADE_CURRENCY_NAMES: Record<string, string> = {
  divine: "Divine Orb",
  exalted: "Exalted Orb",
  mirror: "Mirror of Kalandra",
  alch: "Orb of Alchemy",
  fusing: "Orb of Fusing",
  chance: "Orb of Chance",
  vaal: "Vaal Orb",
  regal: "Regal Orb",
  gcp: "Gemcutter's Prism",
  chrome: "Chromatic Orb",
  jewellers: "Jeweller's Orb",
  alt: "Orb of Alteration",
  scour: "Orb of Scouring",
  regret: "Orb of Regret",
  annul: "Orb of Annulment",
  blessed: "Blessed Orb",
};

/** A price in divines, at today's rates: divine as is, anything else converted through chaos.
 *  Undefined when a rate is missing (sorts last). */
export function priceInDivines(p: ListingPrice | undefined, chaosRates: Record<string, number> | undefined): number | undefined {
  if (!p) return undefined;
  if (p.currency === "divine") return p.amount;
  const divine = chaosRates?.divine;
  const chaos = p.currency === "chaos" ? 1 : chaosRates?.[p.currency];
  return divine && chaos ? (p.amount * chaos) / divine : undefined;
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

/** Ended listings old enough to leave the state (they're already in the archive): once the page no
 *  longer shows them - sold after SOLD_PAGE_DAYS, unsold after UNSOLD_PAGE_DAYS. */
export function endedToDrop(listings: Iterable<TrackedListing>, now: string): string[] {
  const nowMs = Date.parse(now);
  const out: string[] = [];
  for (const t of listings) {
    if (t.status === "listed" || !t.endedAt) continue;
    const keepDays = t.status === "sold" ? SOLD_PAGE_DAYS : UNSOLD_PAGE_DAYS;
    if (nowMs - Date.parse(t.endedAt) > keepDays * DAY_MS) out.push(t.id);
  }
  return out;
}

/**
 * Brings the state's searches in line with searches.md at the start of a run:
 *  - a label gone from the file whose link is now under a new label is a rename: its listings and
 *    status move to the new label;
 *  - a label gone for good is a removed search: listings still up that only it found are dropped
 *    (they aren't results yet, and they'd use the fetch budget and the cap); ones another search
 *    also found carry on under that search. Its sold/unsold listings stay (and in the archive), and
 *    its status is kept, marked `removed`, while any of them is still in the state (on the page).
 * Re-adding a removed search sweeps its listings back in at the next run.
 */
export function reconcileSearches(
  listings: Map<string, TrackedListing>,
  previous: TrackedSearchStatus[],
  current: Array<{ label: string; url: string; error?: string }>,
  now: string
): { statuses: Map<string, TrackedSearchStatus>; renamed: Array<[string, string]>; removed: string[]; dropped: number } {
  const currentLabels = new Set(current.map((s) => s.label));
  const prevByLabel = new Map(previous.map((s) => [s.label, s]));
  const relabel = (from: string, to: string) => {
    for (const t of listings.values()) t.searches = t.searches.map((l) => (l === from ? to : l));
  };
  const renamed: Array<[string, string]> = [];
  for (const p of previous) {
    if (currentLabels.has(p.label)) continue;
    const to = current.find((s) => s.url === p.url && !prevByLabel.has(s.label));
    if (!to) continue;
    relabel(p.label, to.label);
    prevByLabel.delete(p.label);
    prevByLabel.set(to.label, { ...p, label: to.label });
    renamed.push([p.label, to.label]);
  }
  const removed = [...prevByLabel.keys()].filter((l) => !currentLabels.has(l));
  const removedSet = new Set(removed);
  let dropped = 0;
  for (const [key, t] of listings) {
    if (t.status !== "listed" || !t.searches.some((l) => removedSet.has(l))) continue;
    t.searches = t.searches.filter((l) => !removedSet.has(l));
    if (t.searches.length === 0) {
      listings.delete(key);
      dropped++;
    }
  }
  const statuses = new Map<string, TrackedSearchStatus>();
  for (const s of current) {
    const prev = prevByLabel.get(s.label);
    const status: TrackedSearchStatus = { ...(prev?.url === s.url ? prev : {}), label: s.label, url: s.url };
    delete status.removed;
    if (s.error) status.error = s.error;
    else delete status.error;
    statuses.set(s.label, status);
  }
  const stillShown = new Set<string>();
  for (const t of listings.values()) for (const l of t.searches) if (removedSet.has(l)) stillShown.add(l);
  for (const label of removed) {
    if (!stillShown.has(label)) continue;
    // Not running any more: its run state (paused, error, missed listings) no longer applies.
    const prev = { ...prevByLabel.get(label)! };
    delete prev.paused;
    delete prev.error;
    delete prev.missedListings;
    statuses.set(label, { ...prev, removed: prev.removed ?? now });
  }
  return { statuses, renamed, removed, dropped };
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
  // "R1" is a crafted mod's bench rank, not a tier - left out so it doesn't read as a top roll.
  const match = mod.mods?.find((m) => m.tier)?.tier?.match(/^[PS](\d+)$/);
  return match ? Number(match[1]) : undefined;
}

/** The fetch lists fractured and crafted mods among the explicits, marked by `domain`. */
function modKind(mod: TradeMod, listed: ListingModKind): ListingModKind {
  if (typeof mod === "string" || listed !== "explicit") return listed;
  return mod.domain === "fractured" || mod.domain === "crafted" ? mod.domain : listed;
}

// The game's order: enchants, implicits, then fractured mods first and crafted ones last.
const KIND_ORDER: ListingModKind[] = ["enchant", "implicit", "fractured", "explicit", "crafted", "crucible", "scourge"];

const MOD_KINDS: Array<[ListingModKind, keyof TradeItem]> = [
  ["enchant", "enchantMods"],
  ["implicit", "implicitMods"],
  ["fractured", "fracturedMods"],
  ["explicit", "explicitMods"],
  ["crafted", "craftedMods"],
  ["crucible", "crucibleMods"],
  ["scourge", "scourgeMods"],
];

// Value display types the game's item text marks "(augmented)": 1 (changed by a mod) and the
// elemental/chaos damage colours 4-7. 0 is plain, 2 an unmet requirement. (Checked 2026-09-28.)
const AUGMENTED_DISPLAY_TYPES = new Set([1, 4, 5, 6, 7]);

/** "Limited to: 1", or a name with {0} placeholders filled in ("Radius: {0}"). */
function propertyText(p: TradeProperty): string {
  const name = stripGameMarkup(p.name);
  const values = (p.values ?? []).map((v) => (AUGMENTED_DISPLAY_TYPES.has(v[1]) ? `${v[0]} (augmented)` : v[0]));
  if (name.includes("{0}")) return values.reduce((text, v, i) => text.replace(`{${i}}`, v), name);
  return values.length > 0 ? `${name}: ${values.join(", ")}` : name;
}

/** Base64 -> UTF-8, in both Node and the browser (this module is shared). */
function decodeBase64(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The item text (base64 in the fetch) is read for the item class and foil name, not stored whole: at
 * ~1.7 KB it was half of each stored listing; lib/item-text.ts rebuilds it from the rest. Flavour text isn't stored either - nothing shows it.
 */
function toListingDetail(item: TradeItem): SoldListingDetail {
  const text = item.extended?.text ? decodeBase64(item.extended.text).replace(/\r\n/g, "\n").trim() : undefined;
  const tags = [
    ...Object.entries(item.influences ?? {})
      .filter(([, on]) => on)
      .map(([name]) => name[0].toUpperCase() + name.slice(1)),
    ...(item.fractured ? ["Fractured"] : []),
    ...(item.synthesised ? ["Synthesised"] : []),
    // The fetch calls a mirrored item "duplicated".
    ...(item.mirrored || item.duplicated ? ["Mirrored"] : []),
    ...(item.split ? ["Split"] : []),
    ...(item.isRelic ? ["Relic"] : []),
  ];
  // The foil's name ("Celestial Emerald") is only in the item text: "Foil Unique (Celestial Emerald)".
  const foil = text?.match(/^Foil Unique \((.+)\)$/m)?.[1];
  if (foil) tags.push(`Foil: ${foil}`);
  const groups = new Map<number, string[]>();
  for (const s of item.sockets ?? []) groups.set(s.group, [...(groups.get(s.group) ?? []), s.sColour ?? "?"]);
  const itemClass = text?.match(/^Item Class: (.+)$/m)?.[1];
  return {
    ...(itemClass ? { itemClass } : {}),
    properties: (item.properties ?? []).map(propertyText),
    requirements: (item.requirements ?? []).map(propertyText),
    ...(groups.size > 0 ? { sockets: [...groups.values()].map((g) => g.join("-")).join(" ") } : {}),
    tags,
    mods: MOD_KINDS.flatMap(([kind, key]) =>
      ((item[key] as TradeMod[] | undefined) ?? []).flatMap((m) => {
        const t = modText(m);
        const ranges = modRanges(m);
        const tier = modTier(m);
        return t ? [{ kind: modKind(m, kind), text: t, ...(ranges ? { ranges } : {}), ...(tier !== undefined ? { tier } : {}) }] : [];
      })
    ).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)),
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

function newListing(fetched: TradeListing, now: string, searchLabel: string | undefined, seller: string | undefined): TrackedListing {
  const price = fetched.listing.price;
  return {
    id: fetched.id,
    searches: searchLabel ? [searchLabel] : [],
    item: toListingItem(fetched.item),
    prices: price ? [{ amount: price.amount, currency: price.currency, ...(price.type ? { type: price.type } : {}), at: now }] : [],
    listedAt: fetched.listing.indexed,
    lastIndexed: fetched.listing.indexed,
    firstSeen: now,
    lastSeen: now,
    lastChecked: now,
    status: "listed",
    ...(seller ? { seller } : {}),
  };
}

/** What recordListing changed beyond a refresh: a sale that came back. */
export type RelistChange =
  /** Same seller (or one we can't compare): it wasn't a sale. Reopened as listed. */
  | { kind: "reopened"; listing: TrackedListing }
  /** A different seller: the sale was real. `sale` is the sale, moved aside; `listing` the resale. */
  | { kind: "resold"; listing: TrackedListing; sale: TrackedListing };

/**
 * Records a fetched (live) listing: adds it, or refreshes one already tracked - a new price is
 * appended, the seller hash and `indexed` are updated. A listing counted sold that's back is either
 * reopened (same seller: a pull and relist, not a sale) or, when the seller changed, a resale: the
 * sale stays a sale under a new id and the item is tracked afresh, linked to it. Returns the listing
 * and, for a sale that came back, what happened (the caller archives it). `searchLabel` is set when
 * a search found it.
 */
export function recordListing(
  listings: Map<string, TrackedListing>,
  fetched: TradeListing,
  now: string,
  searchLabel?: string
): { listing: TrackedListing; change?: RelistChange } {
  const existing = listings.get(fetched.id);
  const seller = fetched.listing.account?.name ? sellerHash(fetched.listing.account.name) : undefined;
  if (!existing) {
    const t = newListing(fetched, now, searchLabel, seller);
    listings.set(t.id, t);
    return { listing: t };
  }
  if (existing.status === "sold" && existing.seller && seller && existing.seller !== seller) {
    const saleKey = `${existing.id}~${Date.parse(existing.endedAt ?? existing.lastChecked)}`;
    listings.delete(existing.id);
    existing.itemId = existing.id;
    existing.id = saleKey;
    existing.resoldAs = fetched.id;
    listings.set(saleKey, existing);
    const resale = newListing(fetched, now, searchLabel, seller);
    resale.searches = [...new Set([...existing.searches, ...resale.searches])];
    resale.resaleOf = saleKey;
    listings.set(resale.id, resale);
    return { listing: resale, change: { kind: "resold", listing: resale, sale: existing } };
  }
  if (searchLabel && !existing.searches.includes(searchLabel)) existing.searches.push(searchLabel);
  const price = fetched.listing.price;
  const last = currentPrice(existing);
  const priceChanged = !!price && (!last || last.amount !== price.amount || last.currency !== price.currency);
  if (priceChanged) {
    existing.prices.push({ amount: price.amount, currency: price.currency, ...(price.type ? { type: price.type } : {}), at: now });
  }
  const indexed = fetched.listing.indexed;
  const reopening = existing.status === "sold";
  if (!priceChanged && !reopening && indexed && indexed !== (existing.lastIndexed ?? existing.listedAt)) {
    existing.touchedAt = [...(existing.touchedAt ?? []), indexed].slice(-MAX_TOUCHES);
  }
  if (indexed) existing.lastIndexed = indexed;
  if (seller) existing.seller = seller;
  existing.item = toListingItem(fetched.item);
  existing.lastSeen = now;
  existing.lastChecked = now;
  if (reopening) {
    existing.status = "listed";
    existing.reappeared = true;
    existing.relists = [...(existing.relists ?? []), { goneAt: existing.endedAt ?? existing.lastChecked, backAt: now }];
    delete existing.endedAt;
    return { listing: existing, change: { kind: "reopened", listing: existing } };
  }
  return { listing: existing };
}

/** A fetch by id came back gone. A listed listing sold (see the module doc) and is returned, for
 *  the archive. A sale re-checked for a relist (SOLD_RECHECK_DAYS) that's still gone only notes the
 *  check, and returns nothing. */
export function recordMissing(t: TrackedListing, now: string): TrackedListing | undefined {
  t.lastChecked = now;
  if (t.status !== "listed") return undefined;
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

/** Ids due a check, most overdue first: listed ones every RECHECK_LISTED_MINUTES, and recent sales
 *  every RECHECK_SOLD_MINUTES for SOLD_RECHECK_DAYS (a relist check; they share the same fetches). */
export function listingsDueForCheck(listings: Iterable<TrackedListing>, now: string, limit: number): string[] {
  const nowMs = Date.parse(now);
  const due: Array<{ id: string; overdueMs: number }> = [];
  for (const t of listings) {
    let everyMs: number;
    if (t.status === "listed") everyMs = RECHECK_LISTED_MINUTES * 60 * 1000;
    else if (t.status === "sold" && !t.resoldAs && t.endedAt && nowMs - Date.parse(t.endedAt) <= SOLD_RECHECK_DAYS * DAY_MS) {
      everyMs = RECHECK_SOLD_MINUTES * 60 * 1000;
    } else continue;
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
