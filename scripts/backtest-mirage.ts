import {
  getCurrencyGrowthRatiosBatch,
  getItemGrowthRatiosBatch,
  getActualCurrencyValueAtDay,
  getActualItemValueAtDay,
  getCurrencyRecentMomentum,
  getItemRecentMomentum,
  blendGrowthRatio,
  type GrowthRatioRow,
  type RecentMomentumRow,
} from "../lib/growth-ratios";
import { getAllCurrentCurrencyPrices } from "../lib/poe-ninja";
import { CURRENT_LEAGUE } from "../lib/league-recency";

const HOLDOUT_LEAGUE = "Mirage";

// (currentDay, durationDays) scenarios - simulates being at different points in a fresh league.
// Capped so currentDay + durationDays <= 30: past ~day 30 the economy has largely settled (initial
// crafting-currency/gem scarcity has worked itself out), so later scenarios wouldn't tell us much
// about the early-league window this tool actually targets.
const MAX_TOTAL_DAY = 30;
const START_DAYS = [0, 2, 4, 7, 10, 14, 18, 21, 25];
const DURATIONS = [2, 3, 5, 7, 10, 14, 20, 25, 30];
const SCENARIOS: Array<{ currentDay: number; durationDays: number }> = [];
for (const currentDay of START_DAYS) {
  for (const durationDays of DURATIONS) {
    if (currentDay + durationDays <= MAX_TOTAL_DAY) {
      SCENARIOS.push({ currentDay, durationDays });
    }
  }
}

// Recent-momentum validation: matches the live sparkline's fixed 7-day window (see
// lib/poe-ninja.ts's recentRatioFromSparkline) so this backtest actually describes what production
// would see, rather than a lookback that could never be matched live. Trivially widened to a sweep
// (e.g. [5, 7, 10, 14]) later if 7 alone doesn't tell a clear story.
const MOMENTUM_LOOKBACK_DAYS = 7;
// How much weight to give the recent-momentum-extrapolated ratio vs. the pure historical average -
// see blendGrowthRatio. 0 reproduces today's (pre-momentum) behavior exactly.
const ALPHAS = [-1.0, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1.0];

interface MatchedRow {
  key: string;
  category: string;
  /** The pure historical cross-league average ratio - what the model predicted before this feature. */
  avgRatio: number;
  leagueCount: number;
  actualNow: number;
  actualFuture: number;
  actualRatio: number;
  durationDays: number;
  lookbackDays: number;
  /** This specific (holdout) league's own recent trend leading up to currentDay - undefined when
   *  currentDay - lookbackDays < 0 (too close to league launch) or the name had no data that far back. */
  momentumRatio?: number;
  /** Same, but with chaos debasement divided out over the lookback window. */
  momentumRatioDivine?: number;
  /** Same prediction/outcome measured in divines, i.e. with chaos debasement divided out. */
  avgRatioDivine?: number;
  actualRatioDivine?: number;
}

/** One prediction paired with what actually happened, in whichever denomination is being scored. */
interface RatioPair {
  predicted: number;
  actual: number;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function rank(xs: number[]): number[] {
  const indexed = xs.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(xs.length);
  indexed.forEach(({ i }, rankIndex) => {
    ranks[i] = rankIndex + 1;
  });
  return ranks;
}

function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

function spearman(xs: number[], ys: number[]): number {
  return pearson(rank(xs), rank(ys));
}

/** Fraction of pairs where the prediction and reality agree on direction (both a rise or both a fall). */
function directionalAccuracy(pairs: RatioPair[]): number {
  const agree = pairs.filter((p) => (p.predicted >= 1) === (p.actual >= 1)).length;
  return agree / pairs.length;
}

/** Applies a blend weight to a batch of rows, producing the ratios summarize()/chaosPairs()/divinePairs()
 *  actually read - a pure transform so the same MatchedRow[] can be scored at every alpha without re-querying. */
function withPredicted(rows: MatchedRow[], alpha: number): Array<MatchedRow & { predictedRatio: number; predictedRatioDivine?: number }> {
  return rows.map((r) => ({
    ...r,
    predictedRatio: blendGrowthRatio(r.avgRatio, r.momentumRatio, alpha, r.durationDays, r.lookbackDays),
    predictedRatioDivine:
      r.avgRatioDivine !== undefined
        ? blendGrowthRatio(r.avgRatioDivine, r.momentumRatioDivine, alpha, r.durationDays, r.lookbackDays)
        : undefined,
  }));
}

/** Prices in chaos - the model's original denomination, which includes chaos debasement. */
function chaosPairs(rows: Array<{ predictedRatio: number; actualRatio: number }>): RatioPair[] {
  return rows.map((m) => ({ predicted: m.predictedRatio, actual: m.actualRatio }));
}

/** Prices in divines - real value change, with chaos debasement divided out. Rows missing a
 *  Divine Orb rate on either day drop out, so this is scored over a slightly smaller sample. */
function divinePairs(
  rows: Array<{ predictedRatioDivine?: number; actualRatioDivine?: number }>
): RatioPair[] {
  return rows.flatMap((m) =>
    m.predictedRatioDivine !== undefined && m.actualRatioDivine !== undefined
      ? [{ predicted: m.predictedRatioDivine, actual: m.actualRatioDivine }]
      : []
  );
}

function summarize(pairs: RatioPair[]) {
  const predicted = pairs.map((p) => p.predicted);
  const actual = pairs.map((p) => p.actual);
  const absErrors = pairs.map((p) => Math.abs(p.predicted - p.actual));
  return {
    n: pairs.length,
    pearson: pearson(predicted, actual),
    spearman: spearman(predicted, actual),
    mae: mean(absErrors),
    medianAe: median(absErrors),
    directionalAccuracy: directionalAccuracy(pairs),
    avgPredictedX: mean(predicted),
    avgActualX: mean(actual),
  };
}

function divineRatio(now: number | undefined, future: number | undefined): number | undefined {
  if (now === undefined || future === undefined || now <= 0) return undefined;
  return future / now;
}

async function runScenario(
  currentDay: number,
  durationDays: number,
  currencyRatios: GrowthRatioRow[],
  itemRatios: GrowthRatioRow[],
  currencyTypes: Map<string, { type: string }>,
  currencyMomentum: Map<string, RecentMomentumRow>,
  itemMomentum: Map<string, RecentMomentumRow>
): Promise<MatchedRow[]> {
  const targetDay = currentDay + durationDays;

  const [actualNowCurrency, actualFutureCurrency, actualNowItem, actualFutureItem] = await Promise.all([
    getActualCurrencyValueAtDay(HOLDOUT_LEAGUE, currentDay),
    getActualCurrencyValueAtDay(HOLDOUT_LEAGUE, targetDay),
    getActualItemValueAtDay(HOLDOUT_LEAGUE, currentDay),
    getActualItemValueAtDay(HOLDOUT_LEAGUE, targetDay),
  ]);

  const matched: MatchedRow[] = [];

  for (const trend of currencyRatios) {
    const actualNow = actualNowCurrency.get(trend.name);
    const actualFuture = actualFutureCurrency.get(trend.name);
    if (actualNow === undefined || actualFuture === undefined || actualNow.value <= 0) continue;
    const momentum = currencyMomentum.get(trend.name);
    matched.push({
      key: trend.name,
      category: currencyTypes.get(trend.name)?.type ?? "Currency",
      avgRatio: trend.avgRatio,
      leagueCount: trend.leagueCount,
      actualNow: actualNow.value,
      actualFuture: actualFuture.value,
      actualRatio: actualFuture.value / actualNow.value,
      durationDays,
      lookbackDays: MOMENTUM_LOOKBACK_DAYS,
      momentumRatio: momentum?.momentumRatio,
      momentumRatioDivine: momentum?.momentumRatioDivine,
      avgRatioDivine: trend.avgRatioDivine,
      actualRatioDivine: divineRatio(actualNow.valueDivine, actualFuture.valueDivine),
    });
  }

  for (const trend of itemRatios) {
    const key = trend.variant ? `${trend.name}::${trend.variant}` : trend.name;
    const actualNowEntry = actualNowItem.get(key);
    const actualFutureEntry = actualFutureItem.get(key);
    if (actualNowEntry === undefined || actualFutureEntry === undefined || actualNowEntry.value <= 0) continue;
    const momentum = itemMomentum.get(key);
    matched.push({
      key,
      category: actualNowEntry.type ?? actualFutureEntry.type ?? "Unknown",
      avgRatio: trend.avgRatio,
      leagueCount: trend.leagueCount,
      actualNow: actualNowEntry.value,
      actualFuture: actualFutureEntry.value,
      actualRatio: actualFutureEntry.value / actualNowEntry.value,
      durationDays,
      lookbackDays: MOMENTUM_LOOKBACK_DAYS,
      momentumRatio: momentum?.momentumRatio,
      momentumRatioDivine: momentum?.momentumRatioDivine,
      avgRatioDivine: trend.avgRatioDivine,
      actualRatioDivine: divineRatio(actualNowEntry.valueDivine, actualFutureEntry.valueDivine),
    });
  }

  return matched;
}

function alphaComparisonRow(label: string, rows: MatchedRow[], alpha: number) {
  const predicted = withPredicted(rows, alpha);
  const chaos = summarize(chaosPairs(predicted));
  const divine = summarize(divinePairs(predicted));
  return {
    alpha: label,
    n_chaos: chaos.n,
    spearman_chaos: chaos.spearman.toFixed(3),
    "dir%_chaos": Math.round(chaos.directionalAccuracy * 100),
    MAE_chaos: chaos.mae.toFixed(3),
    n_div: divine.n,
    spearman_div: divine.spearman.toFixed(3),
    "dir%_div": Math.round(divine.directionalAccuracy * 100),
    MAE_div: divine.mae.toFixed(3),
  };
}

async function main() {
  console.log(
    `Backtesting flip-suggestion model against holdout league "${HOLDOUT_LEAGUE}" (excluded from training).\n` +
      `${SCENARIOS.length} scenarios, all with currentDay + durationDays <= ${MAX_TOTAL_DAY}. ` +
      `Currency: all confidence levels. Items: High/Medium confidence only.\n`
  );

  // One query per type covering every scenario, instead of one pair per scenario - the expensive
  // part (aggregating the whole multi-league history) doesn't depend on the scenario, so redoing
  // it per scenario is pure waste.
  const [currencyRatiosByScenario, itemRatiosByScenario, currencyTypes] = await Promise.all([
    getCurrencyGrowthRatiosBatch(SCENARIOS, HOLDOUT_LEAGUE),
    getItemGrowthRatiosBatch(SCENARIOS, HOLDOUT_LEAGUE),
    // Currency's historical data has no type bucket of its own (see growth-ratios.ts) - proxy off
    // the live current-league taxonomy, same approach as lib/mirage-simulator.ts, since poe.ninja's
    // type buckets (Scarab, Essence, ...) are a fixed, league-agnostic taxonomy.
    getAllCurrentCurrencyPrices(CURRENT_LEAGUE),
  ]);

  // Momentum only depends on currentDay (not durationDays), so resolve it once per unique currentDay
  // rather than once per scenario - same "don't redo the expensive part per scenario" reasoning as
  // the batch ratio calls above.
  const uniqueCurrentDays = [...new Set(START_DAYS)];
  const momentumByDay = new Map<
    number,
    { currency: Map<string, RecentMomentumRow>; item: Map<string, RecentMomentumRow> }
  >();
  await Promise.all(
    uniqueCurrentDays.map(async (currentDay) => {
      const [currency, item] = await Promise.all([
        getCurrencyRecentMomentum(HOLDOUT_LEAGUE, currentDay, MOMENTUM_LOOKBACK_DAYS),
        getItemRecentMomentum(HOLDOUT_LEAGUE, currentDay, MOMENTUM_LOOKBACK_DAYS),
      ]);
      momentumByDay.set(currentDay, { currency, item });
    })
  );

  const perScenarioSummary: Record<string, unknown>[] = [];
  const allMatched: MatchedRow[] = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const { currentDay, durationDays } = SCENARIOS[i];
    const momentum = momentumByDay.get(currentDay)!;
    const matched = await runScenario(
      currentDay,
      durationDays,
      currencyRatiosByScenario[i],
      itemRatiosByScenario[i],
      currencyTypes,
      momentum.currency,
      momentum.item
    );
    if (matched.length < 5) {
      console.log(`day ${currentDay} -> +${durationDays}d: only ${matched.length} matched items, skipping`);
      continue;
    }
    allMatched.push(...matched);
    // Per-scenario/per-category tables below stay at alpha=0 (today's pure-historical behavior) -
    // the alpha sweep itself is reported separately (see the comparison tables at the end), where
    // pooling across every scenario gives alpha a large enough sample to actually judge.
    const baseline = withPredicted(matched, 0);
    const chaos = summarize(chaosPairs(baseline));
    const divine = summarize(divinePairs(baseline));
    perScenarioSummary.push({
      "day -> +Nd": `${currentDay} -> +${durationDays}d`,
      n: chaos.n,
      spearman_chaos: chaos.spearman.toFixed(3),
      spearman_div: divine.spearman.toFixed(3),
      "dir%_chaos": Math.round(chaos.directionalAccuracy * 100),
      "dir%_div": Math.round(divine.directionalAccuracy * 100),
      MAE_chaos: chaos.mae.toFixed(3),
      MAE_div: divine.mae.toFixed(3),
      "avg actual x_chaos": chaos.avgActualX.toFixed(2),
      "avg actual x_div": divine.avgActualX.toFixed(2),
    });
  }

  console.log(
    `--- Per-scenario results (${perScenarioSummary.length} scenarios with enough data), alpha=0 (pre-momentum baseline) ---\n` +
      `_chaos = prices measured in chaos (includes chaos debasement); _div = measured in divines\n` +
      `(real value change, debasement divided out).\n`
  );
  console.table(perScenarioSummary);

  const pooledBaselineChaos = summarize(chaosPairs(withPredicted(allMatched, 0)));
  const pooledBaselineDivine = summarize(divinePairs(withPredicted(allMatched, 0)));
  console.log("\n--- Chaos vs divine denomination, pooled across every scenario, alpha=0 (baseline) ---");
  console.table([
    {
      denomination: "chaos",
      n: pooledBaselineChaos.n,
      pearson_r: pooledBaselineChaos.pearson.toFixed(3),
      spearman_r: pooledBaselineChaos.spearman.toFixed(3),
      MAE: pooledBaselineChaos.mae.toFixed(3),
      medianAE: pooledBaselineChaos.medianAe.toFixed(3),
      "dir. accuracy%": Math.round(pooledBaselineChaos.directionalAccuracy * 100),
      "avg predicted x": pooledBaselineChaos.avgPredictedX.toFixed(2),
      "avg actual x": pooledBaselineChaos.avgActualX.toFixed(2),
    },
    {
      denomination: "divine",
      n: pooledBaselineDivine.n,
      pearson_r: pooledBaselineDivine.pearson.toFixed(3),
      spearman_r: pooledBaselineDivine.spearman.toFixed(3),
      MAE: pooledBaselineDivine.mae.toFixed(3),
      medianAE: pooledBaselineDivine.medianAe.toFixed(3),
      "dir. accuracy%": Math.round(pooledBaselineDivine.directionalAccuracy * 100),
      "avg predicted x": pooledBaselineDivine.avgPredictedX.toFixed(2),
      "avg actual x": pooledBaselineDivine.avgActualX.toFixed(2),
    },
  ]);

  // Pool every scenario's matches by category to answer "which item types is the model actually
  // reliable for" - a single scenario's category slice is often too small (e.g. 3 Scarabs matched)
  // to trust on its own, but pooled across ~9x9 day/duration combos each category gets a much
  // larger, more stable sample. Still alpha=0 - see the momentum-specific tables below for alpha's effect.
  const byCategory = new Map<string, MatchedRow[]>();
  for (const row of allMatched) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }

  const categorySummary = Array.from(byCategory.entries())
    .filter(([, rows]) => rows.length >= 20) // too few pooled rows to say anything meaningful
    .map(([category, rows]) => {
      const baseline = withPredicted(rows, 0);
      const chaos = summarize(chaosPairs(baseline));
      const divinePairsForCategory = divinePairs(baseline);
      const divine = divinePairsForCategory.length >= 20 ? summarize(divinePairsForCategory) : undefined;
      return {
        category,
        n: chaos.n,
        spearman_r: chaos.spearman,
        spearmanDivine: divine?.spearman,
        MAE: chaos.mae,
        medianAE: chaos.medianAe,
        "dir. accuracy%": Math.round(chaos.directionalAccuracy * 100),
        "dir. accuracy% (div)": divine ? Math.round(divine.directionalAccuracy * 100) : undefined,
      };
    })
    .sort((a, b) => b.spearman_r - a.spearman_r);

  console.log(
    `\n--- Reliability by category, pooled across all ${SCENARIOS.length} scenarios (>= 20 matched rows only), alpha=0 ---\n` +
      `Sorted by Spearman correlation (predicted x vs actual x) descending - higher means the model's\n` +
      `ranking of that category's items is more trustworthy; low/negative means treat its predictions with caution.\n`
  );
  console.table(
    categorySummary.map((c) => ({
      category: c.category,
      n: c.n,
      spearman_chaos: c.spearman_r.toFixed(3),
      spearman_div: c.spearmanDivine !== undefined ? c.spearmanDivine.toFixed(3) : "-",
      "dir%_chaos": c["dir. accuracy%"],
      "dir%_div": c["dir. accuracy% (div)"] ?? "-",
      MAE: c.MAE.toFixed(3),
      medianAE: c.medianAE.toFixed(3),
    }))
  );

  // --- The actual decision artifact for this feature: does blending in recent momentum help? ---
  const withMomentum = allMatched.filter((r) => r.momentumRatio !== undefined);
  console.log(
    `\n--- Momentum blend comparison, lookbackDays=${MOMENTUM_LOOKBACK_DAYS} ---\n` +
      `"all rows" pools every matched row (rows with no momentum signal - currentDay < lookbackDays -\n` +
      `just fall back to the alpha=0 prediction, diluting any real effect). "momentum rows only"\n` +
      `(n=${withMomentum.length} of ${allMatched.length}) restricts to rows where a momentum signal was actually\n` +
      `available (currentDay >= lookbackDays) - this is where alpha's true impact shows up.\n`
  );
  console.log("all rows:");
  console.table(ALPHAS.map((alpha) => alphaComparisonRow(String(alpha), allMatched, alpha)));
  console.log("momentum rows only:");
  console.table(ALPHAS.map((alpha) => alphaComparisonRow(String(alpha), withMomentum, alpha)));

  // Naive momentum extrapolation compounds a short (7-day) observed rate over the FULL
  // durationDays, which should be a much shakier bet for a 30-day projection than a 2-day one (see
  // blendGrowthRatio's doc comment) - break the momentum-available rows down by duration bucket to
  // check whether short horizons behave differently from long ones, rather than judging the whole
  // feature by one pooled number that mixes both.
  const DURATION_BUCKETS: Array<{ label: string; filter: (d: number) => boolean }> = [
    { label: "<=3d", filter: (d) => d <= 3 },
    { label: "5-7d", filter: (d) => d >= 5 && d <= 7 },
    { label: "10-14d", filter: (d) => d >= 10 && d <= 14 },
    { label: ">=18d", filter: (d) => d >= 18 },
  ];
  for (const bucket of DURATION_BUCKETS) {
    const rows = withMomentum.filter((r) => bucket.filter(r.durationDays));
    if (rows.length < 20) continue;
    console.log(`momentum rows only, duration ${bucket.label} (n=${rows.length}):`);
    console.table(ALPHAS.map((alpha) => alphaComparisonRow(String(alpha), rows, alpha)));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
