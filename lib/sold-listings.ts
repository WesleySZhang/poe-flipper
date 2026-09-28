import { readFile } from "node:fs/promises";
import type { SoldTrackerFile } from "./sold-tracker";

/**
 * Reads the sold listing tracker's file for the Sold Listings page. The tracker
 * (scripts/track-sold-listings.ts, run by the "Track sold listings" workflow) publishes it to its own
 * "sold-tracker" branch - not "data", which the daily job rebuilds from scratch every run.
 *
 * Same shape as lib/price-snapshot.ts: raw GitHub file, short in-memory cache, never throws (null =
 * no file yet). SOLD_LISTINGS_FILE points at a local file instead, e.g. a local tracker run's
 * `.sold-tracker/sold-listings/<League>.json`.
 */
const DEFAULT_REPO = "WesleySZhang/poe-flipper";
const TRACKER_BRANCH = "sold-tracker";
const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
// The workflow publishes at the end of each run (every few hours), so a few minutes' cache is plenty.
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { league: string; data: SoldTrackerFile | null; expiresAt: number } | undefined;

function isTrackerFile(value: unknown): value is SoldTrackerFile {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SoldTrackerFile>;
  return v.version === 1 && typeof v.league === "string" && Array.isArray(v.listings) && Array.isArray(v.searches);
}

async function readTrackerFile(league: string): Promise<unknown> {
  const localFile = process.env.SOLD_LISTINGS_FILE;
  if (localFile) return JSON.parse(await readFile(localFile, "utf8"));
  const repo = process.env.PREDICTIONS_REPO ?? DEFAULT_REPO;
  const res = await fetch(
    `https://raw.githubusercontent.com/${repo}/${TRACKER_BRANCH}/sold-listings/${encodeURIComponent(league)}.json`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  return res.ok ? res.json() : null;
}

export async function getSoldListings(league: string): Promise<SoldTrackerFile | null> {
  if (cache && cache.league === league && cache.expiresAt > Date.now()) return cache.data;
  let data: SoldTrackerFile | null = null;
  try {
    const parsed = await readTrackerFile(league);
    if (isTrackerFile(parsed) && parsed.league === league) data = parsed;
  } catch {
    // Missing branch/file, network error or malformed JSON - the page says there's no data yet.
  }
  cache = { league, data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}
