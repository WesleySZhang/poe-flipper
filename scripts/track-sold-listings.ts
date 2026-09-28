/**
 * The sold listing tracker: follows the trade site listings matched by the links in
 * sold-tracker/searches.md and records which ones sell. Runs for --minutes, then exits; the
 * "Track sold listings" workflow runs it once a day and then publishes its file to the sold-tracker
 * branch, where the Sold Listings page reads it (lib/sold-listings.ts). The published file changes
 * only at the end of a run; the local file is saved every few minutes.
 *
 *   npx tsx scripts/track-sold-listings.ts [--minutes 45] [--dir .sold-tracker] [--searches sold-tracker/searches.md]
 *
 * Each loop:
 *  1. Discovery, per search, every DISCOVERY_MINUTES (shorter when a search is busy): the newest
 *     listings first, with the tracker's rules applied (instant buyout, last week - see
 *     applyTrackerRules). A search returns only 100, and a day's new listings can be more: when
 *     all 100 are new, the oldest 100 since the last run are fetched too. New ids are fetched for their item and price - within the limits in
 *     lib/sold-tracker.ts (admitNewListings): a search matching too many listings is paused, and
 *     nothing new is taken in once MAX_TRACKED_LISTINGS listings are being followed.
 *  2. Checks: listed ids due a re-check are fetched by id, 10 per request. A fetch ignores the
 *     search's filters, so a listing repriced out of its search still comes back (a price change);
 *     an empty result means it's gone (lib/sold-tracker.ts decides when gone counts as sold).
 * Requests go through lib/trade-api.ts's rate limiter. The state is saved every few minutes and on
 * exit, so a killed run loses little. A first run picks up at most the newest and oldest 100 of the
 * week per search; after that, new listings are caught as they come.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { CURRENT_LEAGUE } from "../lib/league-recency";
import { TradeApiClient, TradeApiError } from "../lib/trade-api";
import { SEARCHES_DOC, parseSearchesDoc, type TrackedSearch } from "../lib/sold-tracker-searches";
import { withListingAge } from "../lib/trade-query";
import {
  DISCOVERY_MINUTES,
  MAX_LISTINGS_PER_SEARCH,
  MAX_SEARCHES,
  MIN_DISCOVERY_MINUTES,
  SEARCH_RESULT_CAP,
  admitNewListings,
  emptyTrackerFile,
  listingsDueForCheck,
  recordListing,
  recordMissing,
  settleListings,
  type SoldTrackerFile,
  type TrackedListing,
  type TrackedSearchStatus,
} from "../lib/sold-tracker";

const SAVE_EVERY_MS = 5 * 60 * 1000;
const IDLE_SLEEP_MS = 60 * 1000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const minutes = Number(arg("minutes", "45"));
const dir = arg("dir", ".sold-tracker");
const searchesPath = arg("searches", SEARCHES_DOC);
const filePath = path.join(dir, "sold-listings", `${CURRENT_LEAGUE}.json`);

function readSearches(): TrackedSearch[] {
  const searches = parseSearchesDoc(readFileSync(searchesPath, "utf8"));
  // Past MAX_SEARCHES, the rest are paused rather than dropped, so the page still lists them.
  return searches.map((s, i) =>
    i < MAX_SEARCHES || s.error ? s : { ...s, query: undefined, error: `Over the ${MAX_SEARCHES}-search limit` }
  );
}

function loadFile(): SoldTrackerFile {
  if (!existsSync(filePath)) return emptyTrackerFile(CURRENT_LEAGUE);
  const file = JSON.parse(readFileSync(filePath, "utf8")) as SoldTrackerFile;
  return file.version === 1 && file.league === CURRENT_LEAGUE ? file : emptyTrackerFile(CURRENT_LEAGUE);
}

function saveFile(
  file: SoldTrackerFile,
  listings: Map<string, TrackedListing>,
  statuses: Map<string, TrackedSearchStatus>,
  atCapacity: boolean
) {
  file.updatedAt = new Date().toISOString();
  if (atCapacity) file.atCapacity = true;
  else delete file.atCapacity;
  file.searches = [...statuses.values()];
  file.listings = [...listings.values()];
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(file));
  renameSync(tmp, filePath);
}

function log(message: string) {
  console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
}

async function main() {
  const searches = readSearches();
  const file = loadFile();
  const listings = new Map(file.listings.map((t) => [t.id, t]));
  const previous = new Map(file.searches.map((s) => [s.label, s]));
  const statuses = new Map<string, TrackedSearchStatus>(
    searches.map((s) => {
      const prev = previous.get(s.label);
      const status: TrackedSearchStatus = { ...(prev?.url === s.url ? prev : {}), label: s.label, url: s.url };
      if (s.error) status.error = s.error;
      else delete status.error;
      return [s.label, status];
    })
  );
  for (const s of searches) if (s.error) log(`skipping "${s.label}": ${s.error}`);
  const active = searches.filter((s) => s.query);
  log(`${active.length} searches, ${listings.size} listings on file, running ${minutes} min, league ${CURRENT_LEAGUE}`);

  const client = new TradeApiClient();
  const deadline = Date.now() + minutes * 60 * 1000;
  let lastSave = Date.now();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let atCapacity = file.atCapacity ?? false;
  const listedCount = () => {
    let n = 0;
    for (const t of listings.values()) if (t.status === "listed") n++;
    return n;
  };

  async function discover(search: TrackedSearch) {
    const status = statuses.get(search.label)!;
    const now = new Date().toISOString();
    try {
      const newest = await client.search(CURRENT_LEAGUE, search.query, { indexed: "desc" });
      const total = newest.total;
      let ids = newest.ids;
      let missed = false;
      // Every one of the newest 100 is new: the page likely cut off listings since the last run.
      // Fetch the oldest 100 of that window too (limited to the last day or 3 days, as the gap
      // allows), which covers up to 200 new listings per run - the per-search limit averages ~86 a
      // day. Skipped for a search that's over the limit, which admitNewListings pauses anyway.
      if (ids.length >= SEARCH_RESULT_CAP && ids.every((id) => !listings.has(id)) && total <= MAX_LISTINGS_PER_SEARCH) {
        const sinceMs = status.lastRun ? Date.now() - Date.parse(status.lastRun) : Infinity;
        const window = sinceMs <= 24 * 3600e3 ? "1day" : sinceMs <= 72 * 3600e3 ? "3days" : "1week";
        const oldest = await client.search(CURRENT_LEAGUE, withListingAge(search.query!, window), { indexed: "asc" });
        ids = [...new Set([...ids, ...oldest.ids])];
        missed = status.lastRun !== undefined && oldest.total > SEARCH_RESULT_CAP * 2;
      }
      // Unsold records are final; a sold one showing up again is fetched to reopen it.
      const fresh = ids.filter((id) => {
        const t = listings.get(id);
        return !t || t.status === "sold";
      });
      for (const id of ids) {
        const t = listings.get(id);
        if (t?.status === "listed") {
          t.lastSeen = now;
          delete t.missingSince;
          if (!t.searches.includes(search.label)) t.searches.push(search.label);
        }
      }
      const { admit, paused, atCapacity: full } = admitNewListings(fresh, total, listedCount());
      atCapacity = full;
      const fetched = await client.fetchListings(admit);
      fetched.forEach((l) => l && recordListing(listings, l, now, search.label));
      const interval = status.intervalMinutes ?? DISCOVERY_MINUTES;
      // Busy: over half a page of new listings since the last run - look sooner. Quiet (or paused,
      // taking nothing in): ease back.
      const nextInterval =
        !paused && fresh.length > SEARCH_RESULT_CAP / 2
          ? Math.max(MIN_DISCOVERY_MINUTES, interval / 2)
          : Math.min(DISCOVERY_MINUTES, interval * 2);
      Object.assign(status, {
        lastRun: now,
        total,
        newListings: admit.length,
        missedListings: !paused && missed,
        intervalMinutes: nextInterval,
      });
      delete status.error;
      if (paused) status.paused = paused;
      else delete status.paused;
      const skipped = fresh.length - admit.length;
      log(
        `search "${search.label}": ${total} matching, ${admit.length} new` +
          (paused ? ` - PAUSED: ${paused}` : skipped > 0 ? ` - ${skipped} skipped, at the tracking limit` : "") +
          `, next in ${nextInterval} min`
      );
    } catch (e) {
      status.lastRun = now;
      status.error = (e as Error).message;
      log(`search "${search.label}" failed: ${status.error}`);
      if (e instanceof TradeApiError && e.status === 403) throw e;
    }
  }

  async function check(ids: string[]) {
    const fetched = await client.fetchListings(ids);
    const now = new Date().toISOString();
    ids.forEach((id, i) => {
      const l = fetched[i];
      const t = listings.get(id)!;
      if (l) recordListing(listings, l, now);
      else recordMissing(t, now);
    });
  }

  try {
    while (!stopping && Date.now() < deadline) {
      let didWork = false;
      for (const search of active) {
        if (stopping || Date.now() >= deadline) break;
        const status = statuses.get(search.label)!;
        const dueAt = status.lastRun ? Date.parse(status.lastRun) + (status.intervalMinutes ?? DISCOVERY_MINUTES) * 60 * 1000 : 0;
        if (Date.now() >= dueAt) {
          await discover(search);
          didWork = true;
        }
      }
      const due = listingsDueForCheck(listings.values(), new Date().toISOString(), 10);
      if (due.length > 0 && !stopping) {
        await check(due);
        didWork = true;
      }
      settleListings(listings.values(), new Date().toISOString());
      if (Date.now() - lastSave >= SAVE_EVERY_MS) {
        saveFile(file, listings, statuses, atCapacity);
        lastSave = Date.now();
      }
      if (!didWork) await new Promise((r) => setTimeout(r, Math.min(IDLE_SLEEP_MS, Math.max(0, deadline - Date.now()))));
    }
  } finally {
    settleListings(listings.values(), new Date().toISOString());
    saveFile(file, listings, statuses, atCapacity);
    const counts = { listed: 0, sold: 0, unsold: 0 };
    for (const t of listings.values()) counts[t.status]++;
    log(`saved ${filePath}: ${counts.listed} listed, ${counts.sold} sold, ${counts.unsold} unsold`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
