import { jsonResponse } from "@/lib/api-response";
import { getFlipSuggestions } from "@/lib/flip-suggestions";
import { getPrecomputedFlipSuggestions } from "@/lib/precomputed-predictions";
import { currentLeagueDay } from "@/lib/league-day";
import { CURRENT_LEAGUE, CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";

// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why.
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
    if (precomputed) return jsonResponse(precomputed, request);
  }

  const suggestions = await getFlipSuggestions(CURRENT_LEAGUE, currentDay, durationDays);
  return jsonResponse(suggestions, request);
}
