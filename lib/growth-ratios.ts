import { getDb } from "./db";
import { allLeagueRecencyWeights } from "./league-recency";

export interface GrowthRatioRow {
  name: string;
  variant?: string;
  avgRatio: number;
  leagueCount: number;
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
// Below ~1c, tiny absolute price noise (e.g. 0.1c -> 0.4c) produces enormous ratios that
// swamp genuine signal - require a starting price with some weight behind it.
const MIN_STARTING_VALUE = 1;

// A literal SQL VALUES table of every known league's recency weight, for joining onto matched
// rows below. Built from a hardcoded release-date table (see league-recency.ts), not user input,
// so inlining is safe. A league in the historical data that isn't in this table just gets the
// default weight (see leagueRecencyWeight) via COALESCE at the join site.
function leagueWeightsValuesSql(): string {
  return allLeagueRecencyWeights()
    .map(({ league, weight }) => `('${league.replace(/'/g, "''")}', ${weight.toFixed(8)})`)
    .join(", ");
}

// currency_history_dayed/item_history_dayed (one row per league/name[/variant]/day) are built once,
// permanently, at ingest time (see scripts/ingest-history.ts) rather than materialized here at
// query time - the raw per-listing history they're derived from is dropped after ingest, since
// nothing else needs it, which keeps the shipped database small enough to deploy (see README's
// deployment section).
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
  const excludeClause = excludeLeague ? "AND league != $excludeLeague" : "";
  const reader = await db.runAndReadAll(
    `
    WITH league_weights (league, weight) AS (
      VALUES ${leagueWeightsValuesSql()}
    ),
    nearest_now AS (
      SELECT league, name, value AS value_now, day_offset,
             ROW_NUMBER() OVER (PARTITION BY league, name ORDER BY ABS(day_offset - $currentDay)) AS rn
      FROM currency_history_dayed
      WHERE day_offset BETWEEN $currentDay - $tolerance AND $currentDay + $tolerance ${excludeClause}
    ),
    nearest_future AS (
      SELECT league, name, value AS value_future, day_offset,
             ROW_NUMBER() OVER (PARTITION BY league, name ORDER BY ABS(day_offset - $targetDay)) AS rn
      FROM currency_history_dayed
      WHERE day_offset BETWEEN $targetDay - $tolerance AND $targetDay + $tolerance ${excludeClause}
    ),
    matched AS (
      SELECT n.name, f.value_future / NULLIF(n.value_now, 0) AS ratio,
             COALESCE(lw.weight, 1) AS weight
      FROM nearest_now n
      JOIN nearest_future f ON n.league = f.league AND n.name = f.name
      LEFT JOIN league_weights lw ON lw.league = n.league
      WHERE n.rn = 1 AND f.rn = 1
        AND n.value_now >= ${MIN_STARTING_VALUE}
        AND f.value_future > 0
    )
    -- Ratios are multiplicative (a 10x league and a 0.1x league should cancel out), so average
    -- in log space - a plain average would also let one outlier league dominate. Weighted by
    -- league recency on top of that, so a recent league's ratio counts far more than an old one's.
    SELECT name, EXP(SUM(weight * LN(ratio)) / SUM(weight)) AS avg_ratio, COUNT(*) AS league_count
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
  }));
}

/** Same as getCurrencyGrowthRatios but for items/uniques/gems, keyed by (name, variant). */
export async function getItemGrowthRatios(options: GrowthRatioOptions): Promise<GrowthRatioRow[]> {
  const { currentDay, durationDays, excludeLeague, toleranceDays = DEFAULT_TOLERANCE_DAYS } = options;
  const targetDay = currentDay + durationDays;
  const db = await getDb();
  const excludeClause = excludeLeague ? "AND league != $excludeLeague" : "";
  const reader = await db.runAndReadAll(
    `
    WITH league_weights (league, weight) AS (
      VALUES ${leagueWeightsValuesSql()}
    ),
    nearest_now AS (
      SELECT league, name, variant, value AS value_now, day_offset,
             ROW_NUMBER() OVER (PARTITION BY league, name, variant ORDER BY ABS(day_offset - $currentDay)) AS rn
      FROM item_history_dayed
      WHERE day_offset BETWEEN $currentDay - $tolerance AND $currentDay + $tolerance ${excludeClause}
    ),
    nearest_future AS (
      SELECT league, name, variant, value AS value_future, day_offset,
             ROW_NUMBER() OVER (PARTITION BY league, name, variant ORDER BY ABS(day_offset - $targetDay)) AS rn
      FROM item_history_dayed
      WHERE day_offset BETWEEN $targetDay - $tolerance AND $targetDay + $tolerance ${excludeClause}
    ),
    matched AS (
      SELECT n.name, n.variant, f.value_future / NULLIF(n.value_now, 0) AS ratio,
             COALESCE(lw.weight, 1) AS weight
      FROM nearest_now n
      JOIN nearest_future f
        ON n.league = f.league AND n.name = f.name AND n.variant IS NOT DISTINCT FROM f.variant
      LEFT JOIN league_weights lw ON lw.league = n.league
      WHERE n.rn = 1 AND f.rn = 1
        AND n.value_now >= ${MIN_STARTING_VALUE}
        AND f.value_future > 0
    )
    -- Ratios are multiplicative (a 10x league and a 0.1x league should cancel out), so average
    -- in log space - a plain average would also let one outlier league dominate. Weighted by
    -- league recency on top of that, so a recent league's ratio counts far more than an old one's.
    SELECT name, variant, EXP(SUM(weight * LN(ratio)) / SUM(weight)) AS avg_ratio, COUNT(*) AS league_count
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
  }));
}

// Scenario (current_day, target_day) pairs are internal, numeric, and never user-supplied, so
// inlining them as SQL literals alongside league_weights is safe - no injection surface.
function scenarioValuesSql(scenarios: GrowthRatioScenario[]): string {
  return scenarios.map((s, i) => `(${i}, ${s.currentDay}, ${s.currentDay + s.durationDays})`).join(", ");
}

/**
 * Same growth ratio as getCurrencyGrowthRatios, but for many (currentDay, durationDays) scenarios
 * in one query - used by the backtest, which otherwise re-scans the whole dayed table once per
 * scenario for no benefit (the per-league/name aggregation is identical every time; only the
 * "nearest day" window changes). Returns one array per input scenario, same order.
 */
export async function getCurrencyGrowthRatiosBatch(
  scenarios: GrowthRatioScenario[],
  excludeLeague?: string,
  toleranceDays = DEFAULT_TOLERANCE_DAYS
): Promise<GrowthRatioRow[][]> {
  const db = await getDb();
  const excludeClause = excludeLeague ? "AND league != $excludeLeague" : "";
  const reader = await db.runAndReadAll(
    `
    WITH league_weights (league, weight) AS (
      VALUES ${leagueWeightsValuesSql()}
    ),
    scenarios (scenario_id, current_day, target_day) AS (
      VALUES ${scenarioValuesSql(scenarios)}
    ),
    -- Narrow the cross join to only the day range each scenario could ever match, before it
    -- multiplies the dayed table's row count by the scenario count.
    expanded AS (
      SELECT s.scenario_id, s.current_day, s.target_day, d.league, d.name, d.day_offset, d.value
      FROM scenarios s
      JOIN currency_history_dayed d
        ON d.day_offset BETWEEN s.current_day - $tolerance AND s.target_day + $tolerance
      WHERE TRUE ${excludeClause}
    ),
    nearest_now AS (
      SELECT scenario_id, current_day, target_day, league, name, value AS value_now, day_offset,
             ROW_NUMBER() OVER (PARTITION BY scenario_id, league, name ORDER BY ABS(day_offset - current_day)) AS rn
      FROM expanded
      WHERE day_offset BETWEEN current_day - $tolerance AND current_day + $tolerance
    ),
    nearest_future AS (
      SELECT scenario_id, league, name, value AS value_future, day_offset,
             ROW_NUMBER() OVER (PARTITION BY scenario_id, league, name ORDER BY ABS(day_offset - target_day)) AS rn
      FROM expanded
      WHERE day_offset BETWEEN target_day - $tolerance AND target_day + $tolerance
    ),
    matched AS (
      SELECT n.scenario_id, n.name, f.value_future / NULLIF(n.value_now, 0) AS ratio,
             COALESCE(lw.weight, 1) AS weight
      FROM nearest_now n
      JOIN nearest_future f ON n.scenario_id = f.scenario_id AND n.league = f.league AND n.name = f.name
      LEFT JOIN league_weights lw ON lw.league = n.league
      WHERE n.rn = 1 AND f.rn = 1
        AND n.value_now >= ${MIN_STARTING_VALUE}
        AND f.value_future > 0
    )
    SELECT scenario_id, name, EXP(SUM(weight * LN(ratio)) / SUM(weight)) AS avg_ratio, COUNT(*) AS league_count
    FROM matched
    GROUP BY scenario_id, name
    HAVING COUNT(*) >= ${MIN_LEAGUES_WITH_DATA}
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
    list.push({ name: String(row.name), avgRatio: Number(row.avg_ratio), leagueCount: Number(row.league_count) });
    byScenario.set(scenarioId, list);
  }
  return scenarios.map((_, i) => byScenario.get(i) ?? []);
}

/** Same as getCurrencyGrowthRatiosBatch but for items/uniques/gems, keyed by (name, variant). */
export async function getItemGrowthRatiosBatch(
  scenarios: GrowthRatioScenario[],
  excludeLeague?: string,
  toleranceDays = DEFAULT_TOLERANCE_DAYS
): Promise<GrowthRatioRow[][]> {
  const db = await getDb();
  const excludeClause = excludeLeague ? "AND league != $excludeLeague" : "";
  const reader = await db.runAndReadAll(
    `
    WITH league_weights (league, weight) AS (
      VALUES ${leagueWeightsValuesSql()}
    ),
    scenarios (scenario_id, current_day, target_day) AS (
      VALUES ${scenarioValuesSql(scenarios)}
    ),
    -- Narrow the cross join to only the day range each scenario could ever match, before it
    -- multiplies the dayed table's row count by the scenario count.
    expanded AS (
      SELECT s.scenario_id, s.current_day, s.target_day, d.league, d.name, d.variant, d.day_offset, d.value
      FROM scenarios s
      JOIN item_history_dayed d
        ON d.day_offset BETWEEN s.current_day - $tolerance AND s.target_day + $tolerance
      WHERE TRUE ${excludeClause}
    ),
    nearest_now AS (
      SELECT scenario_id, current_day, target_day, league, name, variant, value AS value_now, day_offset,
             ROW_NUMBER() OVER (
               PARTITION BY scenario_id, league, name, variant ORDER BY ABS(day_offset - current_day)
             ) AS rn
      FROM expanded
      WHERE day_offset BETWEEN current_day - $tolerance AND current_day + $tolerance
    ),
    nearest_future AS (
      SELECT scenario_id, league, name, variant, value AS value_future, day_offset,
             ROW_NUMBER() OVER (
               PARTITION BY scenario_id, league, name, variant ORDER BY ABS(day_offset - target_day)
             ) AS rn
      FROM expanded
      WHERE day_offset BETWEEN target_day - $tolerance AND target_day + $tolerance
    ),
    matched AS (
      SELECT n.scenario_id, n.name, n.variant, f.value_future / NULLIF(n.value_now, 0) AS ratio,
             COALESCE(lw.weight, 1) AS weight
      FROM nearest_now n
      JOIN nearest_future f
        ON n.scenario_id = f.scenario_id AND n.league = f.league AND n.name = f.name
        AND n.variant IS NOT DISTINCT FROM f.variant
      LEFT JOIN league_weights lw ON lw.league = n.league
      WHERE n.rn = 1 AND f.rn = 1
        AND n.value_now >= ${MIN_STARTING_VALUE}
        AND f.value_future > 0
    )
    SELECT scenario_id, name, variant, EXP(SUM(weight * LN(ratio)) / SUM(weight)) AS avg_ratio,
           COUNT(*) AS league_count
    FROM matched
    GROUP BY scenario_id, name, variant
    HAVING COUNT(*) >= ${MIN_LEAGUES_WITH_DATA}
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
    });
    byScenario.set(scenarioId, list);
  }
  return scenarios.map((_, i) => byScenario.get(i) ?? []);
}

/** Actual (not averaged/predicted) currency values for one specific league at a given day - used for backtesting. */
export async function getActualCurrencyValueAtDay(
  league: string,
  day: number,
  toleranceDays = DEFAULT_TOLERANCE_DAYS
): Promise<Map<string, number>> {
  const db = await getDb();
  const reader = await db.runAndReadAll(
    `
    WITH nearest AS (
      SELECT name, value, day_offset,
             ROW_NUMBER() OVER (PARTITION BY name ORDER BY ABS(day_offset - $day)) AS rn
      FROM currency_history_dayed
      WHERE league = $league AND day_offset BETWEEN $day - $tolerance AND $day + $tolerance
    )
    SELECT name, value FROM nearest WHERE rn = 1
    `,
    { league, day, tolerance: toleranceDays }
  );
  const map = new Map<string, number>();
  for (const row of reader.getRowObjects()) map.set(String(row.name), Number(row.value));
  return map;
}

export interface ActualItemValue {
  value: number;
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
      SELECT name, variant, value, type, day_offset,
             ROW_NUMBER() OVER (PARTITION BY name, variant ORDER BY ABS(day_offset - $day)) AS rn
      FROM item_history_dayed
      WHERE league = $league AND day_offset BETWEEN $day - $tolerance AND $day + $tolerance
    )
    SELECT name, variant, value, type FROM nearest WHERE rn = 1
    `,
    { league, day, tolerance: toleranceDays }
  );
  const map = new Map<string, ActualItemValue>();
  for (const row of reader.getRowObjects()) {
    const variant = row.variant ? String(row.variant) : "";
    const key = variant ? `${String(row.name)}::${variant}` : String(row.name);
    map.set(key, { value: Number(row.value), type: row.type ? String(row.type) : undefined });
  }
  return map;
}
