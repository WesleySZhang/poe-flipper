import { confidenceScore } from "./confidence";
import { getDb } from "./db";
import { allLeagueRecencyWeights } from "./league-recency";

export interface GrowthRatioRow {
  name: string;
  variant?: string;
  avgRatio: number;
  leagueCount: number;
  /**
   * The same growth ratio measured in divines instead of chaos - i.e. with chaos debasement
   * divided out, so it reflects the item's real change in value rather than the economy inflating
   * around it. Undefined when too few leagues had a Divine Orb rate on both matched days.
   */
  avgRatioDivine?: number;
  leagueCountDivine: number;
  /** How much to trust this prediction, 0-100 - see lib/confidence.ts. Distinct from how big the
   *  predicted gain is: a steady repeat performer and a one-league fluke can share an avgRatio. */
  confidence: number;
  /** Same, measured on the divine-denominated ratios. Undefined on the same thin-data rule that
   *  drops avgRatioDivine. */
  confidenceDivine?: number;
  /** Share of past leagues where this gained, 0-1 - kept alongside the score so the UI can say
   *  "4 of 5 leagues gained" rather than only showing a number. */
  upFraction: number;
  upFractionDivine?: number;
}

export interface GrowthRatioScenario {
  /** Day-of-league (0 = launch day) treated as "now". */
  currentDay: number;
  /** How many days after currentDay to project to. */
  durationDays: number;
}

// A historical league's day must land within this many days of the target day to count as a match -
// otherwise a league that ended early (or started late) would silently extrapolate a misleading price.
export const DEFAULT_TOLERANCE_DAYS = 3;
// The ingested history now only covers a handful of the most recent leagues (see
// scripts/ingest-history.ts's INCLUDED_LEAGUES), and the currently-active/backtested league is
// always excluded on top of that, leaving at most a few training leagues - so 5 (tuned back when
// ~20 leagues were ingested) is often unreachable. 3 was already shown to perform about as well as
// 5 did in that earlier tuning pass.
const MIN_LEAGUES_WITH_DATA = 3;
// Bulk-flipping cheap, high-liquidity currency (Orb of Alteration, Orb of Fusing, etc.) is a real,
// deliberate trading strategy, not noise - buy a stack at a low price, sell it later at a better
// one. This used to sit at 0.2c on the theory that anything cheaper gets too thin/glitchy to trust,
// but checked that empirically: these items are tagged "High" confidence by poe.ninja on
// essentially every single day across every league (Orb of Alteration and Orb of Fusing both never
// once drop below High in the ingested data) - the 0.2c line was catching genuinely well-supported
// bulk currency purely for being cheap, not for being unreliable. Confirmed by sweeping the floor
// from 0.2 down to 0.001: zero currencies produced an extreme (>5x or <0.2x) avgRatio at ANY floor
// tested, so the real protection against bad data is the confidence tag plus the sequential
// magnitude sanity check at ingest time (see ingest-history.ts), not this price cutoff. Still keep
// a small floor rather than 0, purely to guard the division itself against a literal 0 or
// near-zero "value_now" (which would blow the ratio up regardless of confidence).
const MIN_STARTING_VALUE_CURRENCY = 0.02;
// Items don't have the same bulk-flip dynamic - they're traded one at a time, not in stacks - so a
// random item worth a fraction of a chaos is usually just low-value junk. Below ~1c there, tiny
// absolute price noise (e.g. 0.1c -> 0.4c) produces enormous ratios that swamp genuine signal.
const MIN_STARTING_VALUE_ITEM = 1;

// A literal SQL VALUES table of every known league's recency weight, for joining onto matched
// rows below. Built from a hardcoded release-date table (see league-recency.ts) by default, not
// user input, so inlining is safe - `overrideWeights` is also never user-supplied (only the
// backtest passes one, to test alternate weighting schemes), same reasoning applies. A league in
// the historical data that isn't in this table just gets the default weight of 1 via COALESCE at
// the join site (see leagueRecencyWeight, or an override scheme deliberately testing a flat/uniform
// weighting - see backtest-mirage.ts).
function leagueWeightsValuesSql(overrideWeights?: Map<string, number>): string {
  const weights = overrideWeights
    ? Array.from(overrideWeights, ([league, weight]) => ({ league, weight }))
    : allLeagueRecencyWeights();
  return weights.map(({ league, weight }) => `('${league.replace(/'/g, "''")}', ${weight.toFixed(8)})`).join(", ");
}

// currency_history_dayed/item_history_dayed (one row per league/name[/variant]/day) and
// divine_rate_dayed (chaos-per-divine per league/day) are built once, permanently, at ingest time
// (see scripts/ingest-history.ts) rather than materialized here at query time - the raw
// per-listing history they're derived from is dropped after ingest, since nothing else needs it,
// which keeps the shipped database small enough to deploy (see README's deployment section).

// Each matched row carries the Divine Orb rate from its own day, so the divine-denominated ratio
// is (future price in divines) / (now price in divines) - chaos inflation between the two days
// cancels out instead of being counted as growth.
const DIVINE_RATIO_SQL =
  "(f.value_future / NULLIF(f.rate_future, 0)) / NULLIF(n.value_now / NULLIF(n.rate_now, 0), 0)";

// Averaged the same way as the chaos ratio (recency-weighted, in log space), but only over the
// leagues that actually had a divine rate on both days - hence the FILTERs and separate count.
const DIVINE_AGGREGATE_SQL = `
      EXP(
        SUM(weight * LN(ratio_divine)) FILTER (WHERE ratio_divine > 0) /
        NULLIF(SUM(weight) FILTER (WHERE ratio_divine > 0), 0)
      ) AS avg_ratio_divine,
      COUNT(*) FILTER (WHERE ratio_divine > 0) AS league_count_divine,
      SUM(weight * CASE WHEN ratio_divine > 1 THEN 1 ELSE 0 END) FILTER (WHERE ratio_divine > 0) /
        NULLIF(SUM(weight) FILTER (WHERE ratio_divine > 0), 0) AS up_fraction_divine,
      STDDEV_SAMP(LN(ratio_divine)) FILTER (WHERE ratio_divine > 0) AS ratio_spread_divine`;

// The two inputs (beyond league_count, already selected) behind the confidence score - see
// lib/confidence.ts for how they combine and why these two. Both are aggregates over the same
// per-league rows avg_ratio is already averaging, so they cost nothing extra to scan:
//   up_fraction  - weighted share of leagues where this actually gained. Backtested against the
//                  Mirage holdout, "every league gained" preceded a real gain 72.8% of the time vs
//                  37.9% for "most leagues fell", making it the single strongest signal available.
//   ratio_spread - how much the leagues disagreed on magnitude (stddev of the log ratios). Tight
//                  spread halved prediction error (MAE 0.52 vs 1.09) in the same test.
// Weighted to match how avg_ratio itself is weighted, so both follow along if league weighting ever
// changes again (it's flat today - see league-recency.ts).
const CONFIDENCE_AGGREGATE_SQL = `
      SUM(weight * CASE WHEN ratio > 1 THEN 1 ELSE 0 END) / NULLIF(SUM(weight), 0) AS up_fraction,
      STDDEV_SAMP(LN(ratio)) AS ratio_spread`;

/** A divine ratio backed by fewer leagues than the chaos one is too thin to trust - drop it. */
function divineRatioFrom(row: Record<string, unknown>): number | undefined {
  if (Number(row.league_count_divine ?? 0) < MIN_LEAGUES_WITH_DATA) return undefined;
  const parsed = Number(row.avg_ratio_divine);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Chaos-side confidence for a result row - see lib/confidence.ts. */
function confidenceFrom(row: Record<string, unknown>): number {
  return confidenceScore({
    upFraction: Number(row.up_fraction ?? 0),
    // STDDEV_SAMP is NULL for a single league; treat "no spread measurable" as no disagreement,
    // since leagueCount already penalizes the thin sample separately.
    spread: Number(row.ratio_spread ?? 0),
    leagueCount: Number(row.league_count ?? 0),
  });
}

/** Divine-side confidence, gated on the same thin-data rule as the divine ratio itself. */
function confidenceDivineFrom(row: Record<string, unknown>): number | undefined {
  const leagueCountDivine = Number(row.league_count_divine ?? 0);
  if (leagueCountDivine < MIN_LEAGUES_WITH_DATA) return undefined;
  return confidenceScore({
    upFraction: Number(row.up_fraction_divine ?? 0),
    spread: Number(row.ratio_spread_divine ?? 0),
    leagueCount: leagueCountDivine,
  });
}

/** The divine-side gained-share, gated the same way - powers the "N of M leagues gained" hover. */
function upFractionDivineFrom(row: Record<string, unknown>): number | undefined {
  if (Number(row.league_count_divine ?? 0) < MIN_LEAGUES_WITH_DATA) return undefined;
  const parsed = Number(row.up_fraction_divine);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface GrowthRatioOptions extends GrowthRatioScenario {
  /** Exclude this league from the training data (e.g. the player's own active league, or a backtest holdout). */
  excludeLeague?: string;
  toleranceDays?: number;
}

/** Historical growth ratio (price at currentDay+duration / price at currentDay) for currencies, averaged across leagues. */
export async function getCurrencyGrowthRatios(options: GrowthRatioOptions): Promise<GrowthRatioRow[]> {
  const { currentDay, durationDays, excludeLeague, toleranceDays = DEFAULT_TOLERANCE_DAYS } = options;
  const targetDay = currentDay + durationDays;
  const db = await getDb();
  const excludeClause = excludeLeague ? "AND d.league != $excludeLeague" : "";
  const reader = await db.runAndReadAll(
    `
    WITH league_weights (league, weight) AS (
      VALUES ${leagueWeightsValuesSql()}
    ),
    nearest_now AS (
      SELECT d.league, d.name, d.value AS value_now, dr.chaos_per_divine AS rate_now, d.day_offset,
             ROW_NUMBER() OVER (PARTITION BY d.league, d.name ORDER BY ABS(d.day_offset - $currentDay)) AS rn
      FROM currency_history_dayed d
      LEFT JOIN divine_rate_dayed dr ON dr.league = d.league AND dr.day_offset = d.day_offset
      WHERE d.day_offset BETWEEN $currentDay - $tolerance AND $currentDay + $tolerance ${excludeClause}
    ),
    nearest_future AS (
      SELECT d.league, d.name, d.value AS value_future, dr.chaos_per_divine AS rate_future, d.day_offset,
             ROW_NUMBER() OVER (PARTITION BY d.league, d.name ORDER BY ABS(d.day_offset - $targetDay)) AS rn
      FROM currency_history_dayed d
      LEFT JOIN divine_rate_dayed dr ON dr.league = d.league AND dr.day_offset = d.day_offset
      WHERE d.day_offset BETWEEN $targetDay - $tolerance AND $targetDay + $tolerance ${excludeClause}
    ),
    matched AS (
      SELECT n.name, f.value_future / NULLIF(n.value_now, 0) AS ratio,
             ${DIVINE_RATIO_SQL} AS ratio_divine,
             COALESCE(lw.weight, 1) AS weight
      FROM nearest_now n
      JOIN nearest_future f ON n.league = f.league AND n.name = f.name
      LEFT JOIN league_weights lw ON lw.league = n.league
      WHERE n.rn = 1 AND f.rn = 1
        AND n.value_now >= ${MIN_STARTING_VALUE_CURRENCY}
        AND f.value_future > 0
    )
    -- Ratios are multiplicative (a 10x league and a 0.1x league should cancel out), so average
    -- in log space - a plain average would also let one outlier league dominate. Weighted by
    -- league recency on top of that, so a recent league's ratio counts far more than an old one's.
    SELECT name, EXP(SUM(weight * LN(ratio)) / SUM(weight)) AS avg_ratio, COUNT(*) AS league_count,
${DIVINE_AGGREGATE_SQL},${CONFIDENCE_AGGREGATE_SQL}
    FROM matched
    GROUP BY name
    HAVING COUNT(*) >= ${MIN_LEAGUES_WITH_DATA}
    `,
    {
      currentDay,
      targetDay,
      tolerance: toleranceDays,
      ...(excludeLeague ? { excludeLeague } : {}),
    }
  );
  return reader.getRowObjects().map((row) => ({
    name: String(row.name),
    avgRatio: Number(row.avg_ratio),
    leagueCount: Number(row.league_count),
    avgRatioDivine: divineRatioFrom(row),
    leagueCountDivine: Number(row.league_count_divine ?? 0),
    confidence: confidenceFrom(row),
    confidenceDivine: confidenceDivineFrom(row),
    upFraction: Number(row.up_fraction ?? 0),
    upFractionDivine: upFractionDivineFrom(row),
  }));
}

/** Same as getCurrencyGrowthRatios but for items/uniques/gems, keyed by (name, variant). */
export async function getItemGrowthRatios(options: GrowthRatioOptions): Promise<GrowthRatioRow[]> {
  const { currentDay, durationDays, excludeLeague, toleranceDays = DEFAULT_TOLERANCE_DAYS } = options;
  const targetDay = currentDay + durationDays;
  const db = await getDb();
  const excludeClause = excludeLeague ? "AND d.league != $excludeLeague" : "";
  const reader = await db.runAndReadAll(
    `
    WITH league_weights (league, weight) AS (
      VALUES ${leagueWeightsValuesSql()}
    ),
    nearest_now AS (
      SELECT d.league, d.name, d.variant, d.value AS value_now, dr.chaos_per_divine AS rate_now, d.day_offset,
             ROW_NUMBER() OVER (
               PARTITION BY d.league, d.name, d.variant ORDER BY ABS(d.day_offset - $currentDay)
             ) AS rn
      FROM item_history_dayed d
      LEFT JOIN divine_rate_dayed dr ON dr.league = d.league AND dr.day_offset = d.day_offset
      WHERE d.day_offset BETWEEN $currentDay - $tolerance AND $currentDay + $tolerance ${excludeClause}
    ),
    nearest_future AS (
      SELECT d.league, d.name, d.variant, d.value AS value_future, dr.chaos_per_divine AS rate_future, d.day_offset,
             ROW_NUMBER() OVER (
               PARTITION BY d.league, d.name, d.variant ORDER BY ABS(d.day_offset - $targetDay)
             ) AS rn
      FROM item_history_dayed d
      LEFT JOIN divine_rate_dayed dr ON dr.league = d.league AND dr.day_offset = d.day_offset
      WHERE d.day_offset BETWEEN $targetDay - $tolerance AND $targetDay + $tolerance ${excludeClause}
    ),
    matched AS (
      SELECT n.name, n.variant, f.value_future / NULLIF(n.value_now, 0) AS ratio,
             ${DIVINE_RATIO_SQL} AS ratio_divine,
             COALESCE(lw.weight, 1) AS weight
      FROM nearest_now n
      JOIN nearest_future f
        ON n.league = f.league AND n.name = f.name AND n.variant IS NOT DISTINCT FROM f.variant
      LEFT JOIN league_weights lw ON lw.league = n.league
      WHERE n.rn = 1 AND f.rn = 1
        AND n.value_now >= ${MIN_STARTING_VALUE_ITEM}
        AND f.value_future > 0
    )
    -- Ratios are multiplicative (a 10x league and a 0.1x league should cancel out), so average
    -- in log space - a plain average would also let one outlier league dominate. Weighted by
    -- league recency on top of that, so a recent league's ratio counts far more than an old one's.
    SELECT name, variant, EXP(SUM(weight * LN(ratio)) / SUM(weight)) AS avg_ratio, COUNT(*) AS league_count,
${DIVINE_AGGREGATE_SQL},${CONFIDENCE_AGGREGATE_SQL}
    FROM matched
    GROUP BY name, variant
    HAVING COUNT(*) >= ${MIN_LEAGUES_WITH_DATA}
    `,
    {
      currentDay,
      targetDay,
      tolerance: toleranceDays,
      ...(excludeLeague ? { excludeLeague } : {}),
    }
  );
  return reader.getRowObjects().map((row) => ({
    name: String(row.name),
    variant: row.variant ? String(row.variant) : undefined,
    avgRatio: Number(row.avg_ratio),
    leagueCount: Number(row.league_count),
    avgRatioDivine: divineRatioFrom(row),
    leagueCountDivine: Number(row.league_count_divine ?? 0),
    confidence: confidenceFrom(row),
    confidenceDivine: confidenceDivineFrom(row),
    upFraction: Number(row.up_fraction ?? 0),
    upFractionDivine: upFractionDivineFrom(row),
  }));
}

// Scenario (current_day, target_day) pairs are internal, numeric, and never user-supplied, so
// inlining them as SQL literals alongside league_weights is safe - no injection surface.
function scenarioValuesSql(scenarios: GrowthRatioScenario[]): string {
  return scenarios.map((s, i) => `(${i}, ${s.currentDay}, ${s.currentDay + s.durationDays})`).join(", ");
}

export interface GrowthRatioBatchOptions {
  /** Exclude this league from the training data (e.g. the player's own active league, or a backtest holdout). */
  excludeLeague?: string;
  toleranceDays?: number;
  /** Override the default recency-based league weights (see league-recency.ts) - used by the
   *  backtest to test alternate weighting schemes without touching production behavior. A league
   *  missing from this map gets the default weight of 1 via COALESCE at the join site, same as an
   *  unrecognized league normally would - so to deliberately zero a league out, include it
   *  explicitly at weight 0 rather than omitting it. */
  leagueWeights?: Map<string, number>;
  /** Override MIN_LEAGUES_WITH_DATA - e.g. to test training on a single league (with weight 0 on
   *  every other league, since omitting them would just fall back to weight 1 - see above). */
  minLeaguesWithData?: number;
}

/**
 * Same growth ratio as getCurrencyGrowthRatios, but for many (currentDay, durationDays) scenarios
 * in one query - used by the backtest, which otherwise re-scans the whole dayed table once per
 * scenario for no benefit (the per-league/name aggregation is identical every time; only the
 * "nearest day" window changes). Returns one array per input scenario, same order.
 */
export async function getCurrencyGrowthRatiosBatch(
  scenarios: GrowthRatioScenario[],
  options: GrowthRatioBatchOptions = {}
): Promise<GrowthRatioRow[][]> {
  const {
    excludeLeague,
    toleranceDays = DEFAULT_TOLERANCE_DAYS,
    leagueWeights,
    minLeaguesWithData = MIN_LEAGUES_WITH_DATA,
  } = options;
  const db = await getDb();
  const excludeClause = excludeLeague ? "AND d.league != $excludeLeague" : "";
  const reader = await db.runAndReadAll(
    `
    WITH league_weights (league, weight) AS (
      VALUES ${leagueWeightsValuesSql(leagueWeights)}
    ),
    scenarios (scenario_id, current_day, target_day) AS (
      VALUES ${scenarioValuesSql(scenarios)}
    ),
    -- Narrow the cross join to only the day range each scenario could ever match, before it
    -- multiplies the dayed table's row count by the scenario count.
    expanded AS (
      SELECT s.scenario_id, s.current_day, s.target_day, d.league, d.name, d.day_offset, d.value,
             dr.chaos_per_divine AS rate
      FROM scenarios s
      JOIN currency_history_dayed d
        ON d.day_offset BETWEEN s.current_day - $tolerance AND s.target_day + $tolerance
      LEFT JOIN divine_rate_dayed dr ON dr.league = d.league AND dr.day_offset = d.day_offset
      WHERE TRUE ${excludeClause}
    ),
    nearest_now AS (
      SELECT scenario_id, current_day, target_day, league, name, value AS value_now, rate AS rate_now, day_offset,
             ROW_NUMBER() OVER (PARTITION BY scenario_id, league, name ORDER BY ABS(day_offset - current_day)) AS rn
      FROM expanded
      WHERE day_offset BETWEEN current_day - $tolerance AND current_day + $tolerance
    ),
    nearest_future AS (
      SELECT scenario_id, league, name, value AS value_future, rate AS rate_future, day_offset,
             ROW_NUMBER() OVER (PARTITION BY scenario_id, league, name ORDER BY ABS(day_offset - target_day)) AS rn
      FROM expanded
      WHERE day_offset BETWEEN target_day - $tolerance AND target_day + $tolerance
    ),
    matched AS (
      SELECT n.scenario_id, n.name, f.value_future / NULLIF(n.value_now, 0) AS ratio,
             ${DIVINE_RATIO_SQL} AS ratio_divine,
             COALESCE(lw.weight, 1) AS weight
      FROM nearest_now n
      JOIN nearest_future f ON n.scenario_id = f.scenario_id AND n.league = f.league AND n.name = f.name
      LEFT JOIN league_weights lw ON lw.league = n.league
      WHERE n.rn = 1 AND f.rn = 1
        AND n.value_now >= ${MIN_STARTING_VALUE_CURRENCY}
        AND f.value_future > 0
    )
    SELECT scenario_id, name, EXP(SUM(weight * LN(ratio)) / SUM(weight)) AS avg_ratio, COUNT(*) AS league_count,
${DIVINE_AGGREGATE_SQL},${CONFIDENCE_AGGREGATE_SQL}
    FROM matched
    GROUP BY scenario_id, name
    -- SUM(weight) > 0 matters once a caller can override weights (see leagueWeights above): a row
    -- can satisfy COUNT(*) >= minLeaguesWithData purely from leagues weighted to 0 (e.g. testing a
    -- "only this one league counts" scheme), which would otherwise divide by zero into a NaN/Infinity
    -- avg_ratio that still technically passes the row-count check.
    HAVING COUNT(*) >= ${minLeaguesWithData} AND SUM(weight) > 0
    `,
    {
      tolerance: toleranceDays,
      ...(excludeLeague ? { excludeLeague } : {}),
    }
  );
  const byScenario = new Map<number, GrowthRatioRow[]>();
  for (const row of reader.getRowObjects()) {
    const scenarioId = Number(row.scenario_id);
    const list = byScenario.get(scenarioId) ?? [];
    list.push({
      name: String(row.name),
      avgRatio: Number(row.avg_ratio),
      leagueCount: Number(row.league_count),
      avgRatioDivine: divineRatioFrom(row),
      leagueCountDivine: Number(row.league_count_divine ?? 0),
      confidence: confidenceFrom(row),
      confidenceDivine: confidenceDivineFrom(row),
      upFraction: Number(row.up_fraction ?? 0),
      upFractionDivine: upFractionDivineFrom(row),
    });
    byScenario.set(scenarioId, list);
  }
  return scenarios.map((_, i) => byScenario.get(i) ?? []);
}

/** Same as getCurrencyGrowthRatiosBatch but for items/uniques/gems, keyed by (name, variant). */
export async function getItemGrowthRatiosBatch(
  scenarios: GrowthRatioScenario[],
  options: GrowthRatioBatchOptions = {}
): Promise<GrowthRatioRow[][]> {
  const {
    excludeLeague,
    toleranceDays = DEFAULT_TOLERANCE_DAYS,
    leagueWeights,
    minLeaguesWithData = MIN_LEAGUES_WITH_DATA,
  } = options;
  const db = await getDb();
  const excludeClause = excludeLeague ? "AND d.league != $excludeLeague" : "";
  const reader = await db.runAndReadAll(
    `
    WITH league_weights (league, weight) AS (
      VALUES ${leagueWeightsValuesSql(leagueWeights)}
    ),
    scenarios (scenario_id, current_day, target_day) AS (
      VALUES ${scenarioValuesSql(scenarios)}
    ),
    -- Narrow the cross join to only the day range each scenario could ever match, before it
    -- multiplies the dayed table's row count by the scenario count.
    expanded AS (
      SELECT s.scenario_id, s.current_day, s.target_day, d.league, d.name, d.variant, d.day_offset, d.value,
             dr.chaos_per_divine AS rate
      FROM scenarios s
      JOIN item_history_dayed d
        ON d.day_offset BETWEEN s.current_day - $tolerance AND s.target_day + $tolerance
      LEFT JOIN divine_rate_dayed dr ON dr.league = d.league AND dr.day_offset = d.day_offset
      WHERE TRUE ${excludeClause}
    ),
    nearest_now AS (
      SELECT scenario_id, current_day, target_day, league, name, variant, value AS value_now,
             rate AS rate_now, day_offset,
             ROW_NUMBER() OVER (
               PARTITION BY scenario_id, league, name, variant ORDER BY ABS(day_offset - current_day)
             ) AS rn
      FROM expanded
      WHERE day_offset BETWEEN current_day - $tolerance AND current_day + $tolerance
    ),
    nearest_future AS (
      SELECT scenario_id, league, name, variant, value AS value_future, rate AS rate_future, day_offset,
             ROW_NUMBER() OVER (
               PARTITION BY scenario_id, league, name, variant ORDER BY ABS(day_offset - target_day)
             ) AS rn
      FROM expanded
      WHERE day_offset BETWEEN target_day - $tolerance AND target_day + $tolerance
    ),
    matched AS (
      SELECT n.scenario_id, n.name, n.variant, f.value_future / NULLIF(n.value_now, 0) AS ratio,
             ${DIVINE_RATIO_SQL} AS ratio_divine,
             COALESCE(lw.weight, 1) AS weight
      FROM nearest_now n
      JOIN nearest_future f
        ON n.scenario_id = f.scenario_id AND n.league = f.league AND n.name = f.name
        AND n.variant IS NOT DISTINCT FROM f.variant
      LEFT JOIN league_weights lw ON lw.league = n.league
      WHERE n.rn = 1 AND f.rn = 1
        AND n.value_now >= ${MIN_STARTING_VALUE_ITEM}
        AND f.value_future > 0
    )
    SELECT scenario_id, name, variant, EXP(SUM(weight * LN(ratio)) / SUM(weight)) AS avg_ratio,
           COUNT(*) AS league_count,
${DIVINE_AGGREGATE_SQL},${CONFIDENCE_AGGREGATE_SQL}
    FROM matched
    GROUP BY scenario_id, name, variant
    -- See the currency batch query's comment above for why SUM(weight) > 0 is needed alongside the
    -- row-count check once a caller can override weights.
    HAVING COUNT(*) >= ${minLeaguesWithData} AND SUM(weight) > 0
    `,
    {
      tolerance: toleranceDays,
      ...(excludeLeague ? { excludeLeague } : {}),
    }
  );
  const byScenario = new Map<number, GrowthRatioRow[]>();
  for (const row of reader.getRowObjects()) {
    const scenarioId = Number(row.scenario_id);
    const list = byScenario.get(scenarioId) ?? [];
    list.push({
      name: String(row.name),
      variant: row.variant ? String(row.variant) : undefined,
      avgRatio: Number(row.avg_ratio),
      leagueCount: Number(row.league_count),
      avgRatioDivine: divineRatioFrom(row),
      leagueCountDivine: Number(row.league_count_divine ?? 0),
      confidence: confidenceFrom(row),
      confidenceDivine: confidenceDivineFrom(row),
      upFraction: Number(row.up_fraction ?? 0),
      upFractionDivine: upFractionDivineFrom(row),
    });
    byScenario.set(scenarioId, list);
  }
  return scenarios.map((_, i) => byScenario.get(i) ?? []);
}

export interface ActualValue {
  /** Chaos price on the matched day. */
  value: number;
  /** The same price in divines, using the Divine Orb rate from that same day. */
  valueDivine?: number;
}

/** Actual (not averaged/predicted) currency values for one specific league at a given day - used for backtesting. */
export async function getActualCurrencyValueAtDay(
  league: string,
  day: number,
  toleranceDays = DEFAULT_TOLERANCE_DAYS
): Promise<Map<string, ActualValue>> {
  const db = await getDb();
  const reader = await db.runAndReadAll(
    `
    WITH nearest AS (
      SELECT d.name, d.value, dr.chaos_per_divine AS rate, d.day_offset,
             ROW_NUMBER() OVER (PARTITION BY d.name ORDER BY ABS(d.day_offset - $day)) AS rn
      FROM currency_history_dayed d
      LEFT JOIN divine_rate_dayed dr ON dr.league = d.league AND dr.day_offset = d.day_offset
      WHERE d.league = $league AND d.day_offset BETWEEN $day - $tolerance AND $day + $tolerance
    )
    SELECT name, value, rate FROM nearest WHERE rn = 1
    `,
    { league, day, tolerance: toleranceDays }
  );
  const map = new Map<string, ActualValue>();
  for (const row of reader.getRowObjects()) {
    map.set(String(row.name), { value: Number(row.value), valueDivine: divineValueFrom(row) });
  }
  return map;
}

export interface ActualItemValue extends ActualValue {
  /** poe.ninja type bucket (SkillGem, UniqueWeapon, ...), for the category filter - the historical
   * replay has no live poe.ninja data to pull it from, so it comes from item_history instead. */
  type?: string;
}

/** Actual (not averaged/predicted) item values for one specific league at a given day, keyed by name(::variant). */
export async function getActualItemValueAtDay(
  league: string,
  day: number,
  toleranceDays = DEFAULT_TOLERANCE_DAYS
): Promise<Map<string, ActualItemValue>> {
  const db = await getDb();
  const reader = await db.runAndReadAll(
    `
    WITH nearest AS (
      SELECT d.name, d.variant, d.value, d.type, dr.chaos_per_divine AS rate, d.day_offset,
             ROW_NUMBER() OVER (PARTITION BY d.name, d.variant ORDER BY ABS(d.day_offset - $day)) AS rn
      FROM item_history_dayed d
      LEFT JOIN divine_rate_dayed dr ON dr.league = d.league AND dr.day_offset = d.day_offset
      WHERE d.league = $league AND d.day_offset BETWEEN $day - $tolerance AND $day + $tolerance
    )
    SELECT name, variant, value, type, rate FROM nearest WHERE rn = 1
    `,
    { league, day, tolerance: toleranceDays }
  );
  const map = new Map<string, ActualItemValue>();
  for (const row of reader.getRowObjects()) {
    const variant = row.variant ? String(row.variant) : "";
    const key = variant ? `${String(row.name)}::${variant}` : String(row.name);
    map.set(key, {
      value: Number(row.value),
      valueDivine: divineValueFrom(row),
      type: row.type ? String(row.type) : undefined,
    });
  }
  return map;
}

/** Converts a matched row's chaos price to divines using the rate joined from its own day. */
function divineValueFrom(row: Record<string, unknown>): number | undefined {
  const rate = Number(row.rate);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return Number(row.value) / rate;
}
