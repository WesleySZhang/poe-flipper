/**
 * The sold listing tracker: follows the trade site listings matched by the links in
 * sold-tracker/searches.md and records which ones sell. Runs for --minutes, then exits; the
 * "Track sold listings" workflow runs it ~5.5 hours every 6 hours and then publishes --dir to the
 * sold-tracker-data branch, where the Sold Listings page reads it (lib/sold-listings.ts). The published
 * files change only at the end of a run; the local ones are saved every few minutes.
 *
 *   npx tsx scripts/track-sold-listings.ts [--minutes 330] [--dir .sold-tracker] [--searches sold-tracker/searches.md]
 *                                          [--fetch-pace-ms 25000] [--publish-cmd "<command>"]
 *                                          [--publish-every-minutes 30]
 *
 * With --publish-cmd, the files are published as the run goes: right after a save, every
 * PUBLISH_EVERY_MINUTES (the workflow passes scripts/publish-sold-tracker.sh). Publishing from this
 * process, straight after a save, means every snapshot is consistent - nothing is written while it
 * copies. A failed publish is logged and retried at the next one; it never stops tracking.
 *
 * Files under --dir (see lib/sold-tracker.ts for each one's shape):
 *   state/<League>.json          the tracker's state: listed listings, recently ended ones, searches
 *   sold-listings/<League>.json  the page's file: recent sales, unsold and listings still up
 *   ended/<League>/<YYYY-MM-DD>.jsonl  every ended listing, by the day it ended, one per line - the
 *                                      full history (a file per day keeps each far under GitHub's 100 MB)
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
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  SWEEP_MAX_PAGES,
  STATE_KEEP_ENDED_DAYS,
  admitNewListings,
  buildSoldListingsFile,
  dropUnusedDetail,
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
const PUBLISH_EVERY_MINUTES = 30;
const PUBLISH_TIMEOUT_MS = 2 * 60 * 1000;
const STATE_DAYS_LABEL = `${STATE_KEEP_ENDED_DAYS} days`;
const IDLE_SLEEP_MS = 60 * 1000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const minutes = Number(arg("minutes", "330"));
// Lower for a quick local test; the workflow uses the default.
const fetchPaceMs = Number(arg("fetch-pace-ms", String(FETCH_PACE_MS)));
const publishCmd = arg("publish-cmd", "");
const publishEveryMs = Number(arg("publish-every-minutes", String(PUBLISH_EVERY_MINUTES))) * 60 * 1000;
const saveEveryMs = Math.min(SAVE_EVERY_MS, publishEveryMs);
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
  if (state.version !== 2 || state.league !== CURRENT_LEAGUE) return emptyTrackerState(CURRENT_LEAGUE);
  state.listings.forEach(dropUnusedDetail);
  return state;
}

function writeJson(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

// What each day's archive file already holds, as "<id>|<endedAt>" - read once per day per run.
const archived = new Map<string, Set<string>>();

function archivedKeys(day: string): Set<string> {
  let keys = archived.get(day);
  if (!keys) {
    keys = new Set();
    const file = path.join(archiveDir, `${day}.jsonl`);
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const t = JSON.parse(line) as TrackedListing;
        keys.add(`${t.id}|${t.endedAt}`);
      }
    }
    archived.set(day, keys);
  }
  return keys;
}

/**
 * Appends newly ended listings to the archive, by the day they ended - skipping any already
 * there, so it's idempotent: if a run stopped after archiving but before saving its state, the
 * next run settles the same listing again and this adds nothing. (A relisted listing that ends
 * again has a new endedAt, so it's a new line.)
 */
function archive(ended: TrackedListing[]) {
  if (ended.length === 0) return;
  mkdirSync(archiveDir, { recursive: true });
  const byDay = new Map<string, string[]>();
  for (const t of ended) {
    const day = (t.endedAt ?? new Date().toISOString()).slice(0, 10);
    const keys = archivedKeys(day);
    const key = `${t.id}|${t.endedAt}`;
    if (keys.has(key)) continue;
    keys.add(key);
    byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(t)]);
  }
  for (const [day, lines] of byDay) appendFileSync(path.join(archiveDir, `${day}.jsonl`), lines.join("\n") + "\n");
}

/** The archive was once one file per month (YYYY-MM.jsonl): moves any into day files, slimmed. */
function splitMonthArchives() {
  if (!existsSync(archiveDir)) return;
  for (const name of readdirSync(archiveDir)) {
    if (!/^\d{4}-\d{2}\.jsonl$/.test(name)) continue;
    const file = path.join(archiveDir, name);
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    archive(lines.map((l) => dropUnusedDetail(JSON.parse(l) as TrackedListing)));
    unlinkSync(file);
    log(`archive: split ${name} (${lines.length} listings) into day files`);
  }
}

/** Runs --publish-cmd (see the module doc). Never throws: a failure waits for the next publish. */
function publish() {
  if (!publishCmd) return;
  const result = spawnSync(publishCmd, { shell: true, encoding: "utf8", timeout: PUBLISH_TIMEOUT_MS });
  // The command's last line of normal output, or of its errors when it failed.
  const text = result.status === 0 ? result.stdout : `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const output = (text ?? "").trim().split("\n").pop();
  if (result.status === 0) log(`published: ${output}`);
  else log(`publish failed (${result.error?.message ?? `exit ${result.status}`}): ${output} - retrying at the next one`);
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
  splitMonthArchives();
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
  let lastPublish = Date.now();
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

  /**
   * Every listing a search matches, not just the newest page: a search returns at most 100 ids, so
   * this pages through it cheapest first, starting each page at the last one's price. Listings at
   * one price that fill a whole page (e.g. many at a round 100d) are taken newest and oldest first,
   * up to 200. Run once per run per search, it takes in listings discovery never saw - the backlog
   * already up when a search starts, or more new listings than a discovery pass can reach.
   * Returns the ids found, and whether that's all of them.
   */
  async function sweepIds(search: TrackedSearch): Promise<{ ids: Set<string>; total: number; complete: boolean }> {
    const query = search.query!;
    const priceFilter = (query.filters?.trade_filters?.filters?.price ?? {}) as { min?: number; max?: number; option?: string };
    // Paging needs listing prices in the filter's own unit: no option = chaos equivalent.
    const unit = priceFilter.option || "chaos";
    const withPrice = (min: number | undefined, max?: number) => {
      const trade = query.filters?.trade_filters ?? {};
      const price = { ...priceFilter, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
      return { ...query, filters: { ...query.filters, trade_filters: { ...trade, filters: { ...trade.filters, price } } } };
    };
    const ids = new Set<string>();
    let min = priceFilter.min;
    let total = 0;
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const r = await client.search(CURRENT_LEAGUE, withPrice(min), { price: "asc" });
      if (page === 0) {
        total = r.total;
        // Over the limit it's paused (admitNewListings) - don't spend searches paging it.
        if (total > MAX_LISTINGS_PER_SEARCH) return { ids, total, complete: false };
      }
      r.ids.forEach((id) => ids.add(id));
      if (r.total <= r.ids.length) return { ids, total, complete: true };
      const [first, last] = await client.fetchListings([r.ids[0], r.ids[r.ids.length - 1]]);
      const firstPrice = first?.listing.price;
      const lastPrice = last?.listing.price;
      if (!firstPrice || !lastPrice || firstPrice.currency !== unit || lastPrice.currency !== unit) {
        log(`sweep "${search.label}": can't page past a listing not priced in ${unit} - stopped at ${ids.size}`);
        return { ids, total, complete: false };
      }
      if (firstPrice.amount === lastPrice.amount) {
        const p = lastPrice.amount;
        const newest = await client.search(CURRENT_LEAGUE, withPrice(p, p), { indexed: "desc" });
        const oldest = await client.search(CURRENT_LEAGUE, withPrice(p, p), { indexed: "asc" });
        [...newest.ids, ...oldest.ids].forEach((id) => ids.add(id));
        if (newest.total > SEARCH_RESULT_CAP * 2) log(`sweep "${search.label}": ${newest.total} listings at ${p} ${unit}, took 200`);
        min = p + 0.01;
      } else {
        min = lastPrice.amount;
      }
    }
    log(`sweep "${search.label}": stopped after ${SWEEP_MAX_PAGES} pages at ${ids.size}`);
    return { ids, total, complete: false };
  }

  async function sweep(search: TrackedSearch) {
    const status = statuses.get(search.label)!;
    try {
      const { ids, total, complete } = await sweepIds(search);
      const now = new Date().toISOString();
      const fresh: string[] = [];
      for (const id of ids) {
        const t = listings.get(id);
        if (!t || t.status === "sold") fresh.push(id);
        else if (t.status === "listed") {
          t.lastSeen = now;
          if (!t.searches.includes(search.label)) t.searches.push(search.label);
        }
      }
      const { admit, paused, atCapacity: full } = admitNewListings(fresh, total, listedCount());
      atCapacity = full;
      const fetched = await client.fetchListings(admit);
      fetched.forEach((l) => l && recordListing(listings, l, now, search.label));
      status.total = total;
      log(
        `sweep "${search.label}": ${ids.size} of ${total} found${complete ? "" : " (incomplete)"}, ${admit.length} new` +
          (paused ? ` - PAUSED: ${paused}` : fresh.length > admit.length ? ` - ${fresh.length - admit.length} skipped, at the tracking limit` : "")
      );
    } catch (e) {
      log(`sweep "${search.label}" failed: ${(e as Error).message}`);
      if (e instanceof TradeApiError && e.status === 403) throw e;
    }
  }

  async function check(ids: string[]) {
    const fetched = await client.fetchListings(ids);
    const now = new Date().toISOString();
    const sold: TrackedListing[] = [];
    ids.forEach((id, i) => {
      const l = fetched[i];
      const t = listings.get(id)!;
      if (l) recordListing(listings, l, now);
      else sold.push(recordMissing(t, now));
    });
    archive(sold);
  }

  try {
    // Once per run, every listing each search matches (see sweepIds); discovery then keeps up.
    for (const search of active) {
      if (stopping || Date.now() >= deadline) break;
      await sweep(search);
    }
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
      if (Date.now() - lastSave >= saveEveryMs) {
        save(state, listings, statuses, atCapacity);
        lastSave = Date.now();
        if (Date.now() - lastPublish >= publishEveryMs) {
          publish();
          lastPublish = Date.now();
        }
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
