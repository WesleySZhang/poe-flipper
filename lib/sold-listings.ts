import { readFile } from "node:fs/promises";
import { SOLD_TRACKER_DATA_BRANCH } from "./data-branches";
import type { SoldListingsFile } from "./sold-tracker";

/**
 * Reads the sold listing tracker's page file (recent sales and unsold - see buildSoldListingsFile)
 * for the Sold Listings page. The tracker
 * (scripts/track-sold-listings.ts, run by the "Track sold listings" workflow) publishes it to its own
 * "sold-tracker-data" branch - not "precompute-data", which the daily job rebuilds from scratch every run.
 *
 * Same shape as lib/price-snapshot.ts: raw GitHub file, short in-memory cache, never throws (null =
 * no file yet). SOLD_LISTINGS_FILE points at a local file instead, e.g. a local tracker run's
 * `.sold-tracker/sold-listings/<League>.json`.
 */
const DEFAULT_REPO = "WesleySZhang/poe-flipper";
const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
// The workflow publishes at the end of each run (every few hours), so a few minutes' cache is plenty.
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { league: string; data: SoldListingsFile | null; expiresAt: number } | undefined;

function isSoldListingsFile(value: unknown): value is SoldListingsFile {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SoldListingsFile>;
  return (
    v.version === 2 &&
    typeof v.league === "string" &&
    typeof v.trackedCount === "number" &&
    Array.isArray(v.listings) &&
    Array.isArray(v.searches)
  );
}

async function readTrackerFile(league: string): Promise<unknown> {
  const localFile = process.env.SOLD_LISTINGS_FILE;
  if (localFile) return JSON.parse(await readFile(localFile, "utf8"));
  const repo = process.env.PREDICTIONS_REPO ?? DEFAULT_REPO;
  const res = await fetch(
    `https://raw.githubusercontent.com/${repo}/${SOLD_TRACKER_DATA_BRANCH}/sold-listings/${encodeURIComponent(league)}.json`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  return res.ok ? res.json() : null;
}

export async function getSoldListings(league: string): Promise<SoldListingsFile | null> {
  if (cache && cache.league === league && cache.expiresAt > Date.now()) return cache.data;
  let data: SoldListingsFile | null = null;
  try {
    const parsed = await readTrackerFile(league);
    if (isSoldListingsFile(parsed) && parsed.league === league) data = parsed;
  } catch {
    // Missing branch/file, network error or malformed JSON - the page says there's no data yet.
  }
  cache = { league, data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}
