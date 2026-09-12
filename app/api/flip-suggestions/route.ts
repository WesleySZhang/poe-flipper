import { getFlipSuggestions } from "@/lib/flip-suggestions";
import { currentLeagueDay } from "@/lib/league-day";
import { CURRENT_LEAGUE, CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";

// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const durationDays = Number(searchParams.get("durationDays"));
  if (!Number.isFinite(durationDays)) {
    return Response.json({ error: "durationDays must be a number" }, { status: 400 });
  }

  const currentDay = currentLeagueDay(CURRENT_LEAGUE_START_DATE);
  const suggestions = await getFlipSuggestions(CURRENT_LEAGUE, currentDay, durationDays);
  return Response.json(suggestions);
}
