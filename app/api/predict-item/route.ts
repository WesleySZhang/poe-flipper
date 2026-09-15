import {
  getCurrencyGrowthRatiosBatch,
  getItemGrowthRatiosBatch,
  MIN_LEAGUES_WITH_DATA,
} from "@/lib/growth-ratios";
import { MEDIUM_TIER_MIN } from "@/lib/confidence";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why.
//
// Returns only the trained ratio/confidence for one named item - never a predicted price. The
// current-league tester applies the ratio to a price the user types in by hand (poe.ninja doesn't
// expose per-item historical prices for the current, still-running league through its public API,
// only through its own site's UI), so there's no live "now" price for this route to multiply by
// even if it wanted to.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category");
  const name = searchParams.get("name");
  const variant = searchParams.get("variant") || undefined;
  const currentDay = Number(searchParams.get("currentDay"));
  const durationDays = Number(searchParams.get("durationDays"));

  if (category !== "currency" && category !== "item") {
    return Response.json({ error: "category must be 'currency' or 'item'" }, { status: 400 });
  }
  if (!name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  if (!Number.isFinite(currentDay) || !Number.isFinite(durationDays)) {
    return Response.json({ error: "currentDay and durationDays must be numbers" }, { status: 400 });
  }

  // Uses the *Batch functions (normally reserved for the backtest) purely for their
  // minLeaguesWithData override - the normal tables need MIN_LEAGUES_WITH_DATA leagues to agree
  // before trusting a ratio at all, but this is a manual, single-item spot-check the user
  // deliberately opted into, so it's fine to surface a thinner result as long as it's clearly
  // badged as low-confidence (see the cap below) rather than silently hidden. Batch options also
  // still exclude the current league defensively, same as getFlipSuggestions.
  const scenario = { currentDay, durationDays };
  const rows =
    category === "currency"
      ? await getCurrencyGrowthRatiosBatch([scenario], { excludeLeague: CURRENT_LEAGUE, minLeaguesWithData: 1 })
      : await getItemGrowthRatiosBatch([scenario], { excludeLeague: CURRENT_LEAGUE, minLeaguesWithData: 1 });

  const match = rows[0].find((r) => r.name === name && (r.variant ?? undefined) === variant);
  if (!match) {
    return Response.json(
      {
        error:
          "No historical price data for this item near this day at all - it may not have existed in past leagues, or exists under a slightly different name/variant.",
      },
      { status: 404 }
    );
  }

  // A single past league (or two) can't have demonstrated real reliability yet, no matter which
  // way it went - confidenceScore's sample-size term is only a 15% weight, so on its own it doesn't
  // stop a thin sample from still scoring "high" or "medium" (e.g. one league that gained scores
  // ~88). Only ever applies here: every other feature still requires >= MIN_LEAGUES_WITH_DATA
  // leagues before a row is shown at all, so this never touches an already-validated result. The
  // divine-side score doesn't need the same cap - confidenceDivineFrom already returns undefined
  // below that same league count, which the UI already renders as "-".
  const confidence =
    match.leagueCount < MIN_LEAGUES_WITH_DATA ? Math.min(match.confidence, MEDIUM_TIER_MIN - 1) : match.confidence;

  return Response.json({
    avgRatio: match.avgRatio,
    avgRatioDivine: match.avgRatioDivine,
    leagueCount: match.leagueCount,
    leagueCountDivine: match.leagueCountDivine,
    confidence,
    confidenceDivine: match.confidenceDivine,
    upFraction: match.upFraction,
    upFractionDivine: match.upFractionDivine,
  });
}
