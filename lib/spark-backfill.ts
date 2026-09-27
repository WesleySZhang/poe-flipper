/**
 * Rebuilding recent daily prices from poe.ninja's 7-point sparkline, for days the daily history job
 * (scripts/precompute-price-history.ts) missed. Pure, so it can be tested without the network.
 *
 * spark[i] is the % change vs a shared base, oldest first, and the last point is today. Anchoring the
 * last point on today's live price solves for that base, which gives an absolute chaos value for each
 * earlier day. poe.ninja computes the sparkline itself from real daily data (ml/README.md checked it
 * against stored history point-for-point), so this recovers real prices, not estimates of a trend -
 * but from a rounded percentage, so rows built this way are tagged Confidence=Medium, not High.
 */

/** "YYYY-MM-DD" (UTC) `daysAgo` days before `today`. */
export function isoDaysAgo(today: Date, daysAgo: number): string {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** Chaos value `daysAgo` days before today, from a sparkline anchored on today's price; undefined when
 *  the sparkline doesn't reach that far or has no point that day. */
export function valueFromSpark(spark: Array<number | null>, todayChaosValue: number, daysAgo: number): number | undefined {
  const last = spark[spark.length - 1];
  const index = spark.length - 1 - daysAgo;
  if (last === null || last === undefined || index < 0) return undefined;
  const pct = spark[index];
  if (pct === null || pct === undefined) return undefined;
  const value = (todayChaosValue / (1 + last / 100)) * (1 + pct / 100);
  return value > 0 && Number.isFinite(value) ? value : undefined;
}

/** How far back a sparkline reaches: poe.ninja's 7 points = today + 6 earlier days. */
export const SPARK_WINDOW_DAYS = 6;
/** How far back to look for days that are now lost: each one is reported for a week after it falls
 *  out of the window, and the job only has to read the last two weeks of files, not the whole league. */
export const LOST_LOOKBACK_DAYS = 13;

export interface BackfillPlan {
  /** Days in the sparkline window with no rows, oldest first, as { date, daysAgo }. */
  recoverable: Array<{ date: string; daysAgo: number }>;
  /** Days just older than the window with no rows, oldest first. */
  unrecoverable: string[];
}

/**
 * Which recent days to rebuild, and which are lost. `presentDates` is every date with rows in the
 * file (at least the last LOST_LOOKBACK_DAYS of it). Days before the league started, and today itself
 * (written separately), are never included. A lost day only counts from the earliest date present:
 * the job started mid-league, and days before it existed were never going to be there.
 */
export function planBackfill(
  presentDates: Set<string>,
  today: Date,
  leagueStartDate: string,
  windowDays = SPARK_WINDOW_DAYS,
  lookbackDays = LOST_LOOKBACK_DAYS
): BackfillPlan {
  const recoverable: BackfillPlan["recoverable"] = [];
  for (let daysAgo = windowDays; daysAgo >= 1; daysAgo--) {
    const date = isoDaysAgo(today, daysAgo);
    if (date >= leagueStartDate && !presentDates.has(date)) recoverable.push({ date, daysAgo });
  }

  const earliest = [...presentDates].sort()[0];
  const unrecoverable: string[] = [];
  for (let daysAgo = lookbackDays; daysAgo > windowDays; daysAgo--) {
    const date = isoDaysAgo(today, daysAgo);
    if (earliest !== undefined && date >= earliest && date >= leagueStartDate && !presentDates.has(date)) {
      unrecoverable.push(date);
    }
  }
  return { recoverable, unrecoverable };
}
