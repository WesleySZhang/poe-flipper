import { jsonResponse } from "@/lib/api-response";
import { getLiveFlipSuggestionCurve } from "@/lib/flip-suggestions";
import { getPrecomputedPredictionCurve } from "@/lib/precomputed-predictions";
import { currentLeagueDay } from "@/lib/league-day";
import { CURRENT_LEAGUE, CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";

// One item's predicted price at every duration from CURVE_MIN_DURATION_DAYS to
// CURVE_MAX_DURATION_DAYS (lib/flip-suggestions.ts) - the detailed day-by-day forecast line
// components/price-history-chart.tsx draws for days 1-30, instead of a single straight segment to
// whichever one duration the "Days ahead" control happens to be set to. Fetched lazily, only when a
// row's chart is actually expanded (see components/item-history-row.tsx) - never as part of the main
// suggestions table fetch, so this never runs for rows nobody looks at.
//
// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category");
  const historyName = searchParams.get("name");
  const variant = searchParams.get("variant") || undefined;

  if (category !== "currency" && category !== "item") {
    return jsonResponse({ error: "category must be 'currency' or 'item'" }, request, { status: 400 });
  }
  if (!historyName) {
    return jsonResponse({ error: "name is required" }, request, { status: 400 });
  }

  const currentDay = currentLeagueDay(CURRENT_LEAGUE_START_DATE);

  // Fast path: today's precomputed file already has this item's ratio at every duration - no live
  // compute needed. Falls back to actually running the model (once per duration, for this one item)
  // only when that file is missing/stale or doesn't have this particular item.
  const precomputed = await getPrecomputedPredictionCurve(CURRENT_LEAGUE, currentDay, category, historyName, variant);
  if (precomputed) return jsonResponse(precomputed, request);

  const curve = await getLiveFlipSuggestionCurve(CURRENT_LEAGUE, currentDay, category, historyName, variant);
  return jsonResponse(curve, request);
}
