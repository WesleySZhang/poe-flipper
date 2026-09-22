import { jsonResponse } from "@/lib/api-response";
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
export async function GET(request: Request) {
  const currentDay = currentLeagueDay(CURRENT_LEAGUE_START_DATE);
  const data = await getPrecomputedPredictionsFile(CURRENT_LEAGUE, currentDay);
  return jsonResponse(data ?? null, request);
}
