import { getCurrencyGrowthRatios, getItemGrowthRatios } from "@/lib/growth-ratios";
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

  // Excludes the current league defensively, same as getFlipSuggestions - it has no ingested
  // history to exclude yet, but this keeps behaving correctly the day it does.
  const rows =
    category === "currency"
      ? await getCurrencyGrowthRatios({ currentDay, durationDays, excludeLeague: CURRENT_LEAGUE })
      : await getItemGrowthRatios({ currentDay, durationDays, excludeLeague: CURRENT_LEAGUE });

  const match = rows.find((r) => r.name === name && (r.variant ?? undefined) === variant);
  if (!match) {
    return Response.json(
      { error: "No historical prediction for this item at this day/duration - too few past leagues have data." },
      { status: 404 }
    );
  }

  return Response.json({
    avgRatio: match.avgRatio,
    avgRatioDivine: match.avgRatioDivine,
    leagueCount: match.leagueCount,
    leagueCountDivine: match.leagueCountDivine,
    confidence: match.confidence,
    confidenceDivine: match.confidenceDivine,
    upFraction: match.upFraction,
    upFractionDivine: match.upFractionDivine,
  });
}
