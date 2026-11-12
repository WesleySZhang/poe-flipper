import { jsonResponse } from "@/lib/api-response";
import { SIMULATOR_END_MARGIN_DAYS, simulatedLeague } from "@/lib/mirage-league";
import { simulateMirageLeague } from "@/lib/mirage-simulator";

// A plain read - deliberately a Route Handler rather than a Server Action. In Next's dev server,
// Server Actions re-instantiate their module graph on every invocation, which defeated the
// dayed-table caching in growth-ratios.ts (every call re-scanned the full price history). Route
// Handlers don't have that problem, and reads belong here anyway per Next's own guidance -
// Server Actions are for mutations.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const currentDay = Number(searchParams.get("currentDay"));
  const durationDays = Number(searchParams.get("durationDays"));
  // Only the fixed list: the league name ends up in SQL (growth-ratios.ts's league exclusion).
  const league = simulatedLeague(searchParams.get("league"));

  if (!league) return jsonResponse({ error: "unknown league" }, request, { status: 400 });
  if (!Number.isFinite(currentDay) || !Number.isFinite(durationDays) || currentDay < 0 || durationDays < 1) {
    return jsonResponse({ error: "currentDay and durationDays must be numbers" }, request, { status: 400 });
  }
  // Past the league's end there's nothing to score against (see SIMULATOR_END_MARGIN_DAYS).
  if (currentDay + durationDays > league.lastDay - SIMULATOR_END_MARGIN_DAYS) return jsonResponse([], request);

  const rows = await simulateMirageLeague(currentDay, durationDays, { league: league.name });
  return jsonResponse(rows, request);
}
