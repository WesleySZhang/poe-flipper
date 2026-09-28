/**
 * The sold listing tracker: follows the trade site listings matched by the links in
 * sold-tracker/searches.md and records which ones sell. Runs for --minutes, then exits; the
 * "Track sold listings" workflow runs it back to back and publishes its file to the sold-tracker
 * branch, where the Sold Listings page reads it (lib/sold-listings.ts).
 *
 *   npx tsx scripts/track-sold-listings.ts [--minutes 60] [--dir .sold-tracker] [--searches sold-tracker/searches.md]
 *
 * Each loop:
 *  1. Discovery, per search, every DISCOVERY_MINUTES (shorter when a search is busy): the newest
 *     listings first, with the tracker's rules applied (instant buyout, 100d+, last week - see
 *     applyTrackerRules). New ids are fetched for their item and price.
 *  2. Checks: listed ids due a re-check are fetched by id, 10 per request. A fetch ignores the
 *     search's filters, so a listing repriced below 100d still comes back (a price change); an empty
 *     result means it's gone (lib/sold-tracker.ts decides when gone counts as sold).
 * Requests go through lib/trade-api.ts's rate limiter. The state is saved every few minutes and on
 * exit, so a killed run loses little. A search only returns the newest 100, so on a first run only
 * those are picked up; after that, new listings are caught as they come.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { CURRENT_LEAGUE } from "../lib/league-recency";
import { TradeApiClient, TradeApiError } from "../lib/trade-api";
import { applyTrackerRules, describeQuery, parseTradeSearchUrl, type TradeQuery } from "../lib/trade-query";
import {
  DISCOVERY_MINUTES,
  MIN_DISCOVERY_MINUTES,
  SEARCH_RESULT_CAP,
  SOLD_TRACKER_MIN_DIVINES,
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

const minutes = Number(arg("minutes", "60"));
const dir = arg("dir", ".sold-tracker");
const searchesPath = arg("searches", "sold-tracker/searches.md");
const filePath = path.join(dir, "sold-listings", `${CURRENT_LEAGUE}.json`);

interface TrackedSearch {
  label: string;
  url: string;
  query?: TradeQuery;
  error?: string;
}

/**
 * The links under the "## Searches" heading of the searches document: one per list item, either
 * `[label](link)` or a bare link (labelled with the item it searches for).
 */
function readSearches(): TrackedSearch[] {
  const lines = readFileSync(searchesPath, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Searches\s*$/i.test(l));
  if (start === -1) throw new Error(`${searchesPath} has no "## Searches" heading`);
  const out: TrackedSearch[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const item = line.match(/^\s*[-*]\s+(.*)$/)?.[1];
    if (!item) continue;
    const md = item.match(/\[([^\]]+)\]\((\S+?)\)/);
    const url = md?.[2] ?? item.match(/https?:\/\/\S+/)?.[0];
    if (!url) continue;
    let label = md?.[1]?.trim();
    try {
      const { query } = parseTradeSearchUrl(url);
      label ||= describeQuery(query) ?? `Search ${out.length + 1}`;
      out.push({ label, url, query: applyTrackerRules(query, { minDivines: SOLD_TRACKER_MIN_DIVINES }) });
    } catch (e) {
      out.push({ label: label || `Search ${out.length + 1}`, url, error: (e as Error).message });
    }
  }
  // Labels key the listings to their searches, so they must be unique.
  const seen = new Map<string, number>();
  for (const s of out) {
    const n = (seen.get(s.label) ?? 0) + 1;
    seen.set(s.label, n);
    if (n > 1) s.label = `${s.label} (${n})`;
  }
  return out;
}

function loadFile(): SoldTrackerFile {
  if (!existsSync(filePath)) return emptyTrackerFile(CURRENT_LEAGUE);
  const file = JSON.parse(readFileSync(filePath, "utf8")) as SoldTrackerFile;
  return file.version === 1 && file.league === CURRENT_LEAGUE ? file : emptyTrackerFile(CURRENT_LEAGUE);
}

function saveFile(file: SoldTrackerFile, listings: Map<string, TrackedListing>, statuses: Map<string, TrackedSearchStatus>) {
  file.updatedAt = new Date().toISOString();
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

  async function discover(search: TrackedSearch) {
    const status = statuses.get(search.label)!;
    const now = new Date().toISOString();
    try {
      const { ids, total } = await client.search(CURRENT_LEAGUE, search.query, { indexed: "desc" });
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
      const fetched = await client.fetchListings(fresh);
      fetched.forEach((l) => l && recordListing(listings, l, now, search.label));
      const interval = status.intervalMinutes ?? DISCOVERY_MINUTES;
      // Busy: over half a page of new listings since the last run - look sooner. Quiet: ease back.
      const nextInterval =
        fresh.length > SEARCH_RESULT_CAP / 2 ? Math.max(MIN_DISCOVERY_MINUTES, interval / 2) : Math.min(DISCOVERY_MINUTES, interval * 2);
      Object.assign(status, {
        lastRun: now,
        total,
        newListings: fresh.length,
        missedListings: fresh.length >= SEARCH_RESULT_CAP && status.lastRun !== undefined,
        intervalMinutes: nextInterval,
      });
      delete status.error;
      log(`search "${search.label}": ${total} matching, ${fresh.length} new, next in ${nextInterval} min`);
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
        saveFile(file, listings, statuses);
        lastSave = Date.now();
      }
      if (!didWork) await new Promise((r) => setTimeout(r, Math.min(IDLE_SLEEP_MS, Math.max(0, deadline - Date.now()))));
    }
  } finally {
    settleListings(listings.values(), new Date().toISOString());
    saveFile(file, listings, statuses);
    const counts = { listed: 0, sold: 0, unsold: 0 };
    for (const t of listings.values()) counts[t.status]++;
    log(`saved ${filePath}: ${counts.listed} listed, ${counts.sold} sold, ${counts.unsold} unsold`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
