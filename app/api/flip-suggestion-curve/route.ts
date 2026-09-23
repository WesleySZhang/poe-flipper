import { jsonResponse } from "@/lib/api-response";
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
//
// Precomputed-only, deliberately with no live fallback: an earlier version fell back to
// lib/flip-suggestions.ts's getLiveFlipSuggestionCurve, which reran the full cross-sectional
// prediction for the ENTIRE item catalog once per duration (30 durations = 30x a normal request's
// cost) whenever an item wasn't in today's precomputed file. That turned out to be common, not the
// rare edge case it was designed for (a brand-new item, or the file being briefly stale) - plenty of
// perfectly ordinary items simply aren't in the file for other reasons (didn't clear some
// candidate-building threshold that day, etc.) - so this was a real, frequently-hit, CPU-pegging
// multi-second-to-multi-minute stall on an ordinary row/page-expand click. An empty array here just
// means no detailed curve for this item - components/price-history-chart.tsx already draws a plain
// straight segment from today's price to the single selected duration's own prediction (fetched
// separately, cheaply, via /api/flip-suggestions) when predictedCurve is empty/absent, so this is a
// graceful "less detail," not a broken chart.
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
  const precomputed = await getPrecomputedPredictionCurve(CURRENT_LEAGUE, currentDay, category, historyName, variant);
  return jsonResponse(precomputed ?? [], request);
}
