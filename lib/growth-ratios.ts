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
// Bulk-flipping cheap, high-liquidity currency (Orb of Alteration, Armourer's Scrap, etc.) is a
// real, deliberate trading strategy, not noise - buy a stack at a low price, sell it later at a
// better one - but below 0.2c even that gets too thin/glitchy to trust (e.g. Rogue's Marker at
// 0.002c), so still floor it there rather than letting literally everything through.
const MIN_STARTING_VALUE_CURRENCY = 0.2;
// Items don't have the same bulk-flip dynamic - they're traded one at a time, not in stacks - so a
// random item worth a fraction of a chaos is usually just low-value junk. Below ~1c there, tiny
// absolute price noise (e.g. 0.1c -> 0.4c) produces enormous ratios that swamp genuine signal.
const MIN_STARTING_VALUE_ITEM = 1;

// A literal SQL VALUES table of every known league's recency weight, for joining onto matched
// rows below. Built from a hardcoded release-date table (see league-recency.ts), not user input,
// so inlining is safe. A league in the historical data that isn't in this table just gets the
// default weight (see leagueRecencyWeight) via COALESCE at the join site.
function leagueWeightsValuesSql(): string {
  return allLeagueRecencyWeights()
    .map(({ league, weight }) => `('${league.replace(/'/g, "''")}', ${weight.toFixed(8)})`)
    .join(", ");
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
      COUNT(*) FILTER (WHERE ratio_divine > 0) AS league_count_divine`;

/** A divine ratio backed by fewer leagues than the chaos one is too thin to trust - drop it. */
function divineRatioFrom(row: Record<string, unknown>): number | undefined {
  if (Number(row.league_count_divine ?? 0) < MIN_LEAGUES_WITH_DATA) return undefined;
  const parsed = Number(row.avg_ratio_divine);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
${DIVINE_AGGREGATE_SQL}
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
${DIVINE_AGGREGATE_SQL}
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
  const excludeClause = excludeLeague ? "AND d.league != $excludeLeague" : "";
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
${DIVINE_AGGREGATE_SQL}
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
    list.push({
      name: String(row.name),
      avgRatio: Number(row.avg_ratio),
      leagueCount: Number(row.league_count),
      avgRatioDivine: divineRatioFrom(row),
      leagueCountDivine: Number(row.league_count_divine ?? 0),
    });
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
  const excludeClause = excludeLeague ? "AND d.league != $excludeLeague" : "";
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
${DIVINE_AGGREGATE_SQL}
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
      avgRatioDivine: divineRatioFrom(row),
      leagueCountDivine: Number(row.league_count_divine ?? 0),
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

export interface RecentMomentumRow {
  /** value(currentDay) / value(currentDay - lookbackDays), i.e. how this specific league's own
   *  price for this name has moved recently - as opposed to avgRatio, which is a cross-league
   *  historical average and knows nothing about this particular league's trajectory. */
  momentumRatio: number;
  /** Same, but with chaos debasement divided out over the lookback window - undefined if either day
   *  is missing a Divine Orb rate. */
  momentumRatioDivine?: number;
}

/**
 * Recent within-league momentum for currencies - the backtest/mirage-simulator equivalent of the
 * live sparkline (see poe-ninja.ts's recentRatioFromSparkline): both measure "how has this specific
 * league's own price moved over the last `lookbackDays` days", just from different data sources
 * (this one from the already-ingested day_offset history, since a finished/replayed league has no
 * live poe.ninja sparkline to read).
 *
 * Returns an empty map if `currentDay - lookbackDays < 0` (too close to league launch to have a full
 * lookback window) - callers should treat a missing entry as "no momentum signal" and fall back to
 * the pure historical avgRatio, never fabricate one.
 *
 * Note: with the default tolerance window, this requires lookbackDays > 2 * toleranceDays so the
 * "now" and "past" nearest-day windows can't overlap and collapse the ratio toward 1 - at
 * DEFAULT_TOLERANCE_DAYS=3 that's lookbackDays > 6, so the intended lookbackDays=7 sits right at the
 * edge on purpose (matches the live sparkline's fixed 7-day window).
 */
export async function getCurrencyRecentMomentum(
  league: string,
  currentDay: number,
  lookbackDays: number,
  toleranceDays = DEFAULT_TOLERANCE_DAYS
): Promise<Map<string, RecentMomentumRow>> {
  const pastDay = currentDay - lookbackDays;
  if (pastDay < 0) return new Map();
  const [now, past] = await Promise.all([
    getActualCurrencyValueAtDay(league, currentDay, toleranceDays),
    getActualCurrencyValueAtDay(league, pastDay, toleranceDays),
  ]);
  const result = new Map<string, RecentMomentumRow>();
  for (const [name, n] of now) {
    const p = past.get(name);
    if (!p || p.value <= 0 || n.value <= 0) continue;
    const momentumRatioDivine =
      n.valueDivine !== undefined && p.valueDivine !== undefined && p.valueDivine > 0
        ? n.valueDivine / p.valueDivine
        : undefined;
    result.set(name, { momentumRatio: n.value / p.value, momentumRatioDivine });
  }
  return result;
}

/** Same as getCurrencyRecentMomentum but for items/uniques/gems, keyed by (name, variant) like getActualItemValueAtDay. */
export async function getItemRecentMomentum(
  league: string,
  currentDay: number,
  lookbackDays: number,
  toleranceDays = DEFAULT_TOLERANCE_DAYS
): Promise<Map<string, RecentMomentumRow>> {
  const pastDay = currentDay - lookbackDays;
  if (pastDay < 0) return new Map();
  const [now, past] = await Promise.all([
    getActualItemValueAtDay(league, currentDay, toleranceDays),
    getActualItemValueAtDay(league, pastDay, toleranceDays),
  ]);
  const result = new Map<string, RecentMomentumRow>();
  for (const [key, n] of now) {
    const p = past.get(key);
    if (!p || p.value <= 0 || n.value <= 0) continue;
    const momentumRatioDivine =
      n.valueDivine !== undefined && p.valueDivine !== undefined && p.valueDivine > 0
        ? n.valueDivine / p.valueDivine
        : undefined;
    result.set(key, { momentumRatio: n.value / p.value, momentumRatioDivine });
  }
  return result;
}

/**
 * Blends the full-window historical ratio (avgRatio - a cross-league average, knows nothing about
 * THIS league's own trajectory) with a recent within-league momentum ratio (knows nothing about how
 * OTHER leagues tended to move from here, but does know how this one has been moving lately).
 *
 * Extrapolates momentum's implied daily rate forward over durationDays, then combines the two in log
 * space as a weighted geometric mean - consistent with how avgRatio itself is already a
 * recency-weighted geometric mean (see EXP(SUM(weight*LN(ratio))/SUM(weight)) above). alpha=0
 * reproduces the pre-existing pure-historical behavior exactly; alpha=1 ignores history entirely and
 * just extrapolates the recent trend in a straight line.
 *
 * Falls back to historicalRatio untouched whenever momentum isn't usable - no signal, non-finite, or
 * non-positive - so a missing/broken momentum reading can never produce NaN/Infinity downstream.
 *
 * alpha=0 is not special-cased - the formula already reduces to historicalRatio exactly at alpha=0
 * ((1-0)*ln(historical) + 0*rate*duration = ln(historical)) - so alpha may be negative too, to test a
 * mean-reversion ("fade the recent move") hypothesis instead of a momentum-following one.
 */
export function blendGrowthRatio(
  historicalRatio: number,
  momentumRatio: number | undefined,
  alpha: number,
  durationDays: number,
  lookbackDays: number
): number {
  if (
    momentumRatio === undefined ||
    !Number.isFinite(momentumRatio) ||
    momentumRatio <= 0 ||
    !Number.isFinite(historicalRatio) ||
    historicalRatio <= 0
  ) {
    return historicalRatio;
  }
  const momentumDailyLogRate = Math.log(momentumRatio) / lookbackDays;
  return Math.exp((1 - alpha) * Math.log(historicalRatio) + alpha * momentumDailyLogRate * durationDays);
}
