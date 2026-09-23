import { cachedJsonResponse, jsonResponse } from "@/lib/api-response";
import { getFlipSuggestions } from "@/lib/flip-suggestions";
import { getPrecomputedFlipSuggestions } from "@/lib/precomputed-predictions";
import { currentLeagueDay } from "@/lib/league-day";
import { CURRENT_LEAGUE, CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";

// Same TTL as getFlipSuggestions's own data-level cache (lib/flip-suggestions.ts) - this only avoids
// re-running JSON.stringify/gzip on an already-cached array, so there's no reason to keep it fresh
// any longer than that underlying data is itself considered fresh.
const RESPONSE_CACHE_TTL_MS = 60 * 1000;

// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why.
//
// cachedJsonResponse (not plain jsonResponse) for both branches below - this is every item/currency
// in the app, at one specific duration, fetched repeatedly (the main Flip Suggestions table on every
// duration change, the item detail page's own live-fallback duration, ...). The underlying data is
// already cached/coalesced (see getFlipSuggestions and getPrecomputedFlipSuggestions/
// getPrecomputedPredictionsFile's own caches), but without this, JSON.stringify + gzip of that full
// list would still re-run, synchronously, on every one of those repeat requests regardless.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const durationDays = Number(searchParams.get("durationDays"));
  if (!Number.isFinite(durationDays)) {
    return jsonResponse({ error: "durationDays must be a number" }, request, { status: 400 });
  }

  // Optional override so a testing tool can replay the model against a past league day while still
  // pricing off today's live values - see app/current-league-tester/page.tsx. Absent, this behaves
  // exactly as before (today's actual league day).
  const currentDayParam = searchParams.get("currentDay");
  const currentDay = currentDayParam !== null ? Number(currentDayParam) : currentLeagueDay(CURRENT_LEAGUE_START_DATE);
  if (!Number.isFinite(currentDay)) {
    return jsonResponse({ error: "currentDay must be a number" }, request, { status: 400 });
  }

  // Only today's REAL league day can match a precomputed file (it's generated once daily against
  // "today") - an explicit currentDay override (the current-league-tester's backtesting tool) always
  // needs a live computation for that specific historical day, so it skips this entirely.
  if (currentDayParam === null) {
    const precomputed = await getPrecomputedFlipSuggestions(CURRENT_LEAGUE, currentDay, durationDays);
    if (precomputed) {
      return cachedJsonResponse(`flip-suggestions-precomputed:${currentDay}:${durationDays}`, RESPONSE_CACHE_TTL_MS, request, () =>
        Promise.resolve(precomputed)
      );
    }
  }

  return cachedJsonResponse(`flip-suggestions-live:${currentDay}:${durationDays}`, RESPONSE_CACHE_TTL_MS, request, () =>
    getFlipSuggestions(CURRENT_LEAGUE, currentDay, durationDays)
  );
}
