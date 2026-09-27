import { cachedJsonResponse } from "@/lib/api-response";
import { getPrecomputedPredictionsFile } from "@/lib/precomputed-predictions";
import { currentLeagueDay } from "@/lib/league-day";
import { CURRENT_LEAGUE, CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";

// Ships today's WHOLE precomputed predictions file to the browser, once - see
// components/flip-suggestions-panel.tsx for why (dragging the "Days ahead" slider needs to update
// the table with zero further network round-trips, not just an instant local preview number, and the
// only way to do that is for the browser to already have every duration's data on hand). Returns
// null, not an error, when there's nothing usable (file missing/stale) - the panel treats that
// exactly like this endpoint didn't exist and falls back to its normal per-duration fetch.
//
// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why.
//
// cachedJsonResponse (not plain jsonResponse) - this is the single biggest, most-repeated payload
// in the app (every item at every precomputed duration), fetched fresh by EVERY page that has a
// "Days ahead" control (Flip Predictions, the item detail page, ...). getPrecomputedPredictionsFile
// already caches the parsed data, but without this, JSON.stringify + gzip of that multi-MB object
// would still re-run on every single request regardless - a real, synchronous, main-thread-blocking
// cost. Cached under one fixed key (today's file is a singleton, not parameterized) for the same TTL
// lib/precomputed-predictions.ts's own data cache uses.
//
// CDN_CACHE_CONTROL lets Vercel's CDN serve repeats without invoking the function at all, so a cold
// instance doesn't redo the work either. The file changes once a day; s-maxage matches the in-memory
// TTL, and stale-while-revalidate keeps an expired copy serving while one request refreshes it in the
// background, so right after the daily update (or 00:00 UTC) at most ~12 minutes see the old file.
// Safe behind the site password: Vercel runs proxy.ts before its cache, so an unauthenticated request
// is still redirected to /login (see node_modules/next/dist/docs/01-app/02-guides/cdn-caching.md).
// Vercel won't cache a response over 10 MB; this one is ~5.4 MB gzipped at 30 days.
const CDN_CACHE_CONTROL = "public, s-maxage=120, stale-while-revalidate=600";

export async function GET(request: Request) {
  const currentDay = currentLeagueDay(CURRENT_LEAGUE_START_DATE);
  return cachedJsonResponse(
    "flip-suggestions-precomputed",
    2 * 60 * 1000,
    request,
    async () => {
      const data = await getPrecomputedPredictionsFile(CURRENT_LEAGUE, currentDay);
      return data ?? null;
    },
    { cacheControl: CDN_CACHE_CONTROL }
  );
}
