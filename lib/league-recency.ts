import { daysBetweenUtc } from "./league-day";

/**
 * Release dates for past challenge leagues, most recent first. Keyed on the short name as it
 * appears in the ingested history tables (e.g. "Mirage", not "Mirage league").
 * Source: PoE wiki league list (as of 2026-09-12). Only the leagues actually ingested (see
 * scripts/ingest-history.ts's INCLUDED_LEAGUES - the model is intentionally trained on just the
 * last few leagues for data quality) plus the current one need an entry here; a league with no
 * ingested history simply never matches a row in growth-ratios.ts's queries either way.
 */
const LEAGUE_RELEASE_DATES: Record<string, string> = {
  Allflame: "2026-07-24",
  Mirage: "2026-03-06",
  Keepers: "2025-10-31",
  Mercenaries: "2025-06-13",
  Settlers: "2024-07-26",
};

/**
 * The currently active challenge league - Allflame has no end date above, meaning it's still
 * running. There's no clean poe.ninja/GGG endpoint for "what league is active right now" that's
 * worth adding a dependency on, so this is kept in sync by hand alongside the table above each
 * time a new league launches. Used to skip asking the user which league they're playing.
 */
export const CURRENT_LEAGUE = "Allflame";
export const CURRENT_LEAGUE_START_DATE = LEAGUE_RELEASE_DATES[CURRENT_LEAGUE];

// Anchor recency to the most recent *completed* league rather than "today" - Allflame is still
// active league-to-date, so anchoring there would make every past league's weight drift downward
// as the active league ages, even though nothing about the historical data changed.
const RECENCY_ANCHOR = LEAGUE_RELEASE_DATES["Mirage"];

// Weight halves every ~6 months of release-date distance from the anchor league, so the last
// couple of leagues dominate the average while leagues from a few years back barely register.
const HALF_LIFE_DAYS = 180;

/**
 * How much a league's data point should count toward an averaged prediction, in (0, 1] - 1.0 for
 * the anchor league, decaying by half every HALF_LIFE_DAYS of release-date distance from it.
 * Leagues with no known release date (e.g. one the data source ingested under an unexpected name)
 * get full weight rather than being silently zeroed out.
 */
export function leagueRecencyWeight(league: string): number {
  const releaseDate = LEAGUE_RELEASE_DATES[league];
  if (!releaseDate) return 1;
  const daysFromAnchor = Math.abs(daysBetweenUtc(new Date(releaseDate), new Date(RECENCY_ANCHOR)));
  return Math.pow(0.5, daysFromAnchor / HALF_LIFE_DAYS);
}

/** All known leagues with their recency weight - used to build a SQL VALUES table for joining. */
export function allLeagueRecencyWeights(): Array<{ league: string; weight: number }> {
  return Object.keys(LEAGUE_RELEASE_DATES).map((league) => ({ league, weight: leagueRecencyWeight(league) }));
}
