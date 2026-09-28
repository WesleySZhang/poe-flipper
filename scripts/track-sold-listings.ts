/**
 * The sold listing tracker: follows the trade site listings matched by the links in
 * sold-tracker/searches.md and records which ones sell. Runs for --minutes, then exits; the
 * "Track sold listings" workflow runs it ~5.5 hours every 6 hours and then publishes --dir to the
 * sold-tracker branch, where the Sold Listings page reads it (lib/sold-listings.ts). The published
 * files change only at the end of a run; the local ones are saved every few minutes.
 *
 *   npx tsx scripts/track-sold-listings.ts [--minutes 330] [--dir .sold-tracker] [--searches sold-tracker/searches.md]
 *                                          [--fetch-pace-ms 25000]
 *
 * Files under --dir (see lib/sold-tracker.ts for each one's shape):
 *   state/<League>.json          the tracker's state: listed listings, recently ended ones, searches
 *   sold-listings/<League>.json  the page's file: recent sales and unsold, listings gone but pending
 *   ended/<League>/<YYYY-MM>.jsonl  every ended listing, one per line - the full history
 *
 * Each loop:
 *  1. Discovery, per search, every DISCOVERY_MINUTES (shorter when a search is busy): the newest
 *     listings first, with the tracker's rules applied (instant buyout, last week - see
 *     applyTrackerRules). A search returns only 100, and the new listings since the last run can be
 *     more: when all 100 are new, the oldest 100 since the last run are fetched too. New ids are
 *     fetched for their item and price - within the limits in lib/sold-tracker.ts
 *     (admitNewListings): a search matching too many listings is paused, and nothing new is taken
 *     in once MAX_TRACKED_LISTINGS listings are being followed.
 *  2. Checks: listed ids due a re-check are fetched by id, 10 per request. A fetch ignores the
 *     search's filters, so a listing repriced out of its search still comes back (a price change);
 *     an empty result means it's gone (lib/sold-tracker.ts decides when gone counts as sold).
 * Requests go through lib/trade-api.ts's rate limiter, with fetches paced (FETCH_PACE_MS) so a run's
 * ~600 fetches are spread over hours rather than bursts. The state is saved every few minutes and on
 * exit, so a killed run loses little. A first run picks up at most the newest and oldest 100 of the
 * week per search; after that, new listings are caught as they come.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CURRENT_LEAGUE } from "../lib/league-recency";
import { TradeApiClient, TradeApiError } from "../lib/trade-api";
import { SEARCHES_DOC, parseSearchesDoc, type TrackedSearch } from "../lib/sold-tracker-searches";
import { withListingAge } from "../lib/trade-query";
import {
  DISCOVERY_MINUTES,
  FETCH_PACE_MS,
  MAX_LISTINGS_PER_SEARCH,
  MAX_SEARCHES,
  MIN_DISCOVERY_MINUTES,
  SEARCH_RESULT_CAP,
  STATE_KEEP_ENDED_DAYS,
  admitNewListings,
  buildSoldListingsFile,
  emptyTrackerState,
  endedToDrop,
  listingsDueForCheck,
  recordListing,
  recordMissing,
  settleListings,
  type TrackedListing,
  type TrackerState,
  type TrackedSearchStatus,
} from "../lib/sold-tracker";

const SAVE_EVERY_MS = 5 * 60 * 1000;
const STATE_DAYS_LABEL = `${STATE_KEEP_ENDED_DAYS} days`;
const IDLE_SLEEP_MS = 60 * 1000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const minutes = Number(arg("minutes", "330"));
// Lower for a quick local test; the workflow uses the default.
const fetchPaceMs = Number(arg("fetch-pace-ms", String(FETCH_PACE_MS)));
const dir = arg("dir", ".sold-tracker");
const searchesPath = arg("searches", SEARCHES_DOC);
const statePath = path.join(dir, "state", `${CURRENT_LEAGUE}.json`);
const pagePath = path.join(dir, "sold-listings", `${CURRENT_LEAGUE}.json`);
const archiveDir = path.join(dir, "ended", CURRENT_LEAGUE);

function readSearches(): TrackedSearch[] {
  const searches = parseSearchesDoc(readFileSync(searchesPath, "utf8"));
  // Past MAX_SEARCHES, the rest are paused rather than dropped, so the page still lists them.
  return searches.map((s, i) =>
    i < MAX_SEARCHES || s.error ? s : { ...s, query: undefined, error: `Over the ${MAX_SEARCHES}-search limit` }
  );
}

function loadState(): TrackerState {
  if (!existsSync(statePath)) return emptyTrackerState(CURRENT_LEAGUE);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as TrackerState;
  return state.version === 2 && state.league === CURRENT_LEAGUE ? state : emptyTrackerState(CURRENT_LEAGUE);
}

function writeJson(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

/** Appends newly ended listings to the archive, by the month they ended. */
function archive(ended: TrackedListing[]) {
  if (ended.length === 0) return;
  mkdirSync(archiveDir, { recursive: true });
  const byMonth = new Map<string, string[]>();
  for (const t of ended) {
    const month = (t.endedAt ?? new Date().toISOString()).slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), JSON.stringify(t)]);
  }
  for (const [month, lines] of byMonth) appendFileSync(path.join(archiveDir, `${month}.jsonl`), lines.join("\n") + "\n");
}

/** Saves the state and the page's file, dropping ended listings the state no longer needs. */
function save(
  state: TrackerState,
  listings: Map<string, TrackedListing>,
  statuses: Map<string, TrackedSearchStatus>,
  atCapacity: boolean
) {
  const now = new Date().toISOString();
  for (const id of endedToDrop(listings.values(), now)) listings.delete(id);
  state.updatedAt = now;
  if (atCapacity) state.atCapacity = true;
  else delete state.atCapacity;
  state.searches = [...statuses.values()];
  state.listings = [...listings.values()];
  writeJson(statePath, state);
  writeJson(pagePath, buildSoldListingsFile(state, listings.values(), now));
}

function log(message: string) {
  console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
}

async function main() {
  const searches = readSearches();
  const state = loadState();
  const listings = new Map(state.listings.map((t) => [t.id, t]));
  const previous = new Map(state.searches.map((s) => [s.label, s]));
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

  const client = new TradeApiClient({ fetch: fetchPaceMs });
  const deadline = Date.now() + minutes * 60 * 1000;
  let lastSave = Date.now();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let atCapacity = state.atCapacity ?? false;
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
      // allows), which covers up to 200 new listings per run - the per-search limit averages ~110
      // per 6 hours. Skipped for a search that's over the limit, which admitNewListings pauses anyway.
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
      archive(settleListings(listings.values(), new Date().toISOString()));
      if (Date.now() - lastSave >= SAVE_EVERY_MS) {
        save(state, listings, statuses, atCapacity);
        lastSave = Date.now();
      }
      if (!didWork) await new Promise((r) => setTimeout(r, Math.min(IDLE_SLEEP_MS, Math.max(0, deadline - Date.now()))));
    }
  } finally {
    archive(settleListings(listings.values(), new Date().toISOString()));
    save(state, listings, statuses, atCapacity);
    const counts = { listed: 0, sold: 0, unsold: 0 };
    for (const t of listings.values()) counts[t.status]++;
    log(`saved ${dir}: ${counts.listed} listed, ${counts.sold} sold, ${counts.unsold} unsold (last ${STATE_DAYS_LABEL})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
