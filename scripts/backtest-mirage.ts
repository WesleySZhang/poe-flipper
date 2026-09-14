import {
  getCurrencyGrowthRatiosBatch,
  getItemGrowthRatiosBatch,
  getActualCurrencyValueAtDay,
  getActualItemValueAtDay,
  type GrowthRatioRow,
  type GrowthRatioBatchOptions,
} from "../lib/growth-ratios";
import { confidenceTier, type ConfidenceTier } from "../lib/confidence";
import { getAllCurrentCurrencyPrices } from "../lib/poe-ninja";
import {
  CURRENT_LEAGUE,
  HALF_LIFE_DAYS,
  allLeagueRecencyWeightsWithHalfLife,
  allKnownLeagues,
} from "../lib/league-recency";

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

/** Weight 1 for exactly one league, 0 for every other known league (rather than omitting them,
 *  which would fall back to the default weight of 1 - see GrowthRatioBatchOptions.leagueWeights). */
function onlyLeagueWeights(league: string): Map<string, number> {
  return new Map(allKnownLeagues().map((l) => [l, l === league ? 1 : 0]));
}

interface WeightingScheme {
  label: string;
  /** undefined = production default - see league-recency.ts's allLeagueRecencyWeights (flat,
   *  as of the comparison this file ran: recency decay measurably hurt predictions - see below). */
  weights?: Map<string, number>;
  minLeaguesWithData?: number;
}

// Training leagues (everything except the HOLDOUT_LEAGUE and the still-active CURRENT_LEAGUE) are
// currently Keepers (2025-10-31), Mercenaries (2025-06-13), Settlers (2024-07-26), and Phrecia 2.0
// (2026-01-29) - Phrecia 2.0 is the most recent of the four, which is why it's the target for the
// "most recent league only" scheme below. Update this if the training league set changes.
const MOST_RECENT_TRAINING_LEAGUE = "Phrecia 2.0";

// WEIGHTING_SCHEMES[0] is always the one main() runs the full per-scenario/per-category breakdown
// for (see "baseline" below) - kept as whatever's actually live in production, so that detailed
// output always describes what's actually shipping. Production is flat weighting (no recency
// effect) as of the run that produced the comment on allLeagueRecencyWeights - every half-life
// variant below is a comparison-only data point showing why: prediction quality degraded
// monotonically as the decay got more aggressive, all the way from the old 180-day default down to
// an extreme 14-day half-life.
const WEIGHTING_SCHEMES: WeightingScheme[] = [
  { label: "flat (current production default)" },
  { label: `half-life ${HALF_LIFE_DAYS}d (former default)`, weights: allLeagueRecencyWeightsWithHalfLife(HALF_LIFE_DAYS) },
  { label: "half-life 120d", weights: allLeagueRecencyWeightsWithHalfLife(120) },
  { label: "half-life 90d", weights: allLeagueRecencyWeightsWithHalfLife(90) },
  { label: "half-life 45d", weights: allLeagueRecencyWeightsWithHalfLife(45) },
  { label: "half-life 14d (extreme recency)", weights: allLeagueRecencyWeightsWithHalfLife(14) },
  {
    label: `most recent league only (${MOST_RECENT_TRAINING_LEAGUE})`,
    weights: onlyLeagueWeights(MOST_RECENT_TRAINING_LEAGUE),
    minLeaguesWithData: 1,
  },
];

interface MatchedRow {
  key: string;
  category: string;
  predictedRatio: number;
  leagueCount: number;
  actualNow: number;
  actualFuture: number;
  actualRatio: number;
  /** Same prediction/outcome measured in divines, i.e. with chaos debasement divided out. */
  predictedRatioDivine?: number;
  actualRatioDivine?: number;
  /** Confidence the model assigned from the training leagues alone - scored before seeing any of
   *  the holdout's outcome, so checking it against actualRatio below is a fair test. */
  confidence: number;
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

/** Prices in chaos - the model's original denomination, which includes chaos debasement. */
function chaosPairs(rows: MatchedRow[]): RatioPair[] {
  return rows.map((m) => ({ predicted: m.predictedRatio, actual: m.actualRatio }));
}

/** Prices in divines - real value change, with chaos debasement divided out. Rows missing a
 *  Divine Orb rate on either day drop out, so this is scored over a slightly smaller sample. */
function divinePairs(rows: MatchedRow[]): RatioPair[] {
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

async function runScenario(
  currentDay: number,
  durationDays: number,
  currencyRatios: GrowthRatioRow[],
  itemRatios: GrowthRatioRow[],
  currencyTypes: Map<string, { type: string }>
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
    matched.push({
      key: trend.name,
      category: currencyTypes.get(trend.name)?.type ?? "Currency",
      predictedRatio: trend.avgRatio,
      leagueCount: trend.leagueCount,
      actualNow: actualNow.value,
      actualFuture: actualFuture.value,
      actualRatio: actualFuture.value / actualNow.value,
      predictedRatioDivine: trend.avgRatioDivine,
      confidence: trend.confidence,
      actualRatioDivine: divineRatio(actualNow.valueDivine, actualFuture.valueDivine),
    });
  }

  for (const trend of itemRatios) {
    const key = trend.variant ? `${trend.name}::${trend.variant}` : trend.name;
    const actualNowEntry = actualNowItem.get(key);
    const actualFutureEntry = actualFutureItem.get(key);
    if (actualNowEntry === undefined || actualFutureEntry === undefined || actualNowEntry.value <= 0) continue;
    matched.push({
      key,
      category: actualNowEntry.type ?? actualFutureEntry.type ?? "Unknown",
      predictedRatio: trend.avgRatio,
      leagueCount: trend.leagueCount,
      actualNow: actualNowEntry.value,
      actualFuture: actualFutureEntry.value,
      actualRatio: actualFutureEntry.value / actualNowEntry.value,
      predictedRatioDivine: trend.avgRatioDivine,
      confidence: trend.confidence,
      actualRatioDivine: divineRatio(actualNowEntry.valueDivine, actualFutureEntry.valueDivine),
    });
  }

  return matched;
}

function divineRatio(now: number | undefined, future: number | undefined): number | undefined {
  if (now === undefined || future === undefined || now <= 0) return undefined;
  return future / now;
}

/** Runs every scenario under one weighting scheme, returning every matched row pooled together
 *  (per-scenario/per-category breakdowns are only printed for the baseline scheme - see main()). */
async function runBacktest(
  batchOptions: GrowthRatioBatchOptions,
  currencyTypes: Map<string, { type: string }>,
  logSkips: boolean
): Promise<{ allMatched: MatchedRow[]; perScenarioSummary: Record<string, unknown>[] }> {
  const [currencyRatiosByScenario, itemRatiosByScenario] = await Promise.all([
    getCurrencyGrowthRatiosBatch(SCENARIOS, batchOptions),
    getItemGrowthRatiosBatch(SCENARIOS, batchOptions),
  ]);

  const perScenarioSummary: Record<string, unknown>[] = [];
  const allMatched: MatchedRow[] = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const { currentDay, durationDays } = SCENARIOS[i];
    const matched = await runScenario(
      currentDay,
      durationDays,
      currencyRatiosByScenario[i],
      itemRatiosByScenario[i],
      currencyTypes
    );
    if (matched.length < 5) {
      if (logSkips) console.log(`day ${currentDay} -> +${durationDays}d: only ${matched.length} matched items, skipping`);
      continue;
    }
    allMatched.push(...matched);
    const chaos = summarize(chaosPairs(matched));
    const divine = summarize(divinePairs(matched));
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

  return { allMatched, perScenarioSummary };
}

function weightingComparisonRow(label: string, allMatched: MatchedRow[]) {
  const chaos = summarize(chaosPairs(allMatched));
  const divine = summarize(divinePairs(allMatched));
  return {
    scheme: label,
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

  // Currency's historical data has no type bucket of its own (see growth-ratios.ts) - proxy off the
  // live current-league taxonomy, same approach as lib/mirage-simulator.ts, since poe.ninja's type
  // buckets (Scarab, Essence, ...) are a fixed, league-agnostic taxonomy. Doesn't depend on the
  // weighting scheme, so fetched once and reused across every scheme below.
  const currencyTypes = await getAllCurrentCurrencyPrices(CURRENT_LEAGUE);

  // The baseline (production) scheme gets the full per-scenario + per-category breakdown, exactly
  // as before - every other scheme only contributes a pooled row to the comparison table at the
  // end, since running the full breakdown for all 7 schemes would be far more output than useful.
  const baseline = WEIGHTING_SCHEMES[0];
  const { allMatched: baselineMatched, perScenarioSummary } = await runBacktest(
    { excludeLeague: HOLDOUT_LEAGUE, leagueWeights: baseline.weights, minLeaguesWithData: baseline.minLeaguesWithData },
    currencyTypes,
    true
  );

  console.log(
    `--- Per-scenario results (${perScenarioSummary.length} scenarios with enough data), "${baseline.label}" ---\n` +
      `_chaos = prices measured in chaos (includes chaos debasement); _div = measured in divines\n` +
      `(real value change, debasement divided out).\n`
  );
  console.table(perScenarioSummary);

  const pooledChaos = summarize(chaosPairs(baselineMatched));
  const pooledDivine = summarize(divinePairs(baselineMatched));
  console.log(`\n--- Chaos vs divine denomination, pooled across every scenario, "${baseline.label}" ---`);
  console.table([
    {
      denomination: "chaos",
      n: pooledChaos.n,
      pearson_r: pooledChaos.pearson.toFixed(3),
      spearman_r: pooledChaos.spearman.toFixed(3),
      MAE: pooledChaos.mae.toFixed(3),
      medianAE: pooledChaos.medianAe.toFixed(3),
      "dir. accuracy%": Math.round(pooledChaos.directionalAccuracy * 100),
      "avg predicted x": pooledChaos.avgPredictedX.toFixed(2),
      "avg actual x": pooledChaos.avgActualX.toFixed(2),
    },
    {
      denomination: "divine",
      n: pooledDivine.n,
      pearson_r: pooledDivine.pearson.toFixed(3),
      spearman_r: pooledDivine.spearman.toFixed(3),
      MAE: pooledDivine.mae.toFixed(3),
      medianAE: pooledDivine.medianAe.toFixed(3),
      "dir. accuracy%": Math.round(pooledDivine.directionalAccuracy * 100),
      "avg predicted x": pooledDivine.avgPredictedX.toFixed(2),
      "avg actual x": pooledDivine.avgActualX.toFixed(2),
    },
  ]);

  // Pool every scenario's matches by category to answer "which item types is the model actually
  // reliable for" - a single scenario's category slice is often too small (e.g. 3 Scarabs matched)
  // to trust on its own, but pooled across ~9x9 day/duration combos each category gets a much
  // larger, more stable sample.
  const byCategory = new Map<string, MatchedRow[]>();
  for (const row of baselineMatched) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }

  const categorySummary = Array.from(byCategory.entries())
    .filter(([, rows]) => rows.length >= 20) // too few pooled rows to say anything meaningful
    .map(([category, rows]) => {
      const chaos = summarize(chaosPairs(rows));
      const divinePairsForCategory = divinePairs(rows);
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
    `\n--- Reliability by category, pooled across all ${SCENARIOS.length} scenarios (>= 20 matched rows only), "${baseline.label}" ---\n` +
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

  // --- League-weighting scheme comparison: does favoring recent leagues more (or less, or
  // exclusively) actually improve predictions, or just feel intuitive? ---
  console.log(
    `\n--- League-weighting scheme comparison, pooled across every scenario ---\n` +
      `Each row re-runs the full backtest with a different league-recency weighting. "flat" is the\n` +
      `production default (unchanged, same numbers as above) - every league counts equally, no\n` +
      `recency effect. The half-life rows show why: smaller half-life = more weight on recent\n` +
      `leagues, less on old ones, and prediction quality degrades monotonically as that gets more\n` +
      `aggressive. "most recent league only" trains on nothing but the single newest training league.\n`
  );
  const comparisonRows = [weightingComparisonRow(baseline.label, baselineMatched)];
  for (const scheme of WEIGHTING_SCHEMES.slice(1)) {
    const { allMatched } = await runBacktest(
      { excludeLeague: HOLDOUT_LEAGUE, leagueWeights: scheme.weights, minLeaguesWithData: scheme.minLeaguesWithData },
      currencyTypes,
      false
    );
    comparisonRows.push(weightingComparisonRow(scheme.label, allMatched));
  }
  console.table(comparisonRows);

  // --- Confidence tiers: does the badge the UI shows actually mean anything? ---
  // The gate for shipping the confidence column. Each row's score came from the training leagues
  // only, so comparing it against what Mirage actually did is a fair out-of-sample test. If the
  // tiers don't separate on "actually gained", the badge is decoration and shouldn't be shown.
  console.log(
    `\n--- Confidence tier reliability, pooled across every scenario, "${baseline.label}" ---\n` +
      `Confidence answers "how reliably has this gained before", so the column that matters is\n` +
      `"actually gained %" - not MAE, which runs HIGHER for confident rows simply because reliable\n` +
      `gainers move further. Tiers should separate cleanly top to bottom.\n`
  );
  const byTier = new Map<ConfidenceTier, MatchedRow[]>();
  for (const row of baselineMatched) {
    const tier = confidenceTier(row.confidence);
    const list = byTier.get(tier) ?? [];
    list.push(row);
    byTier.set(tier, list);
  }
  const TIER_ORDER: ConfidenceTier[] = ["high", "medium", "low"];
  console.table(
    TIER_ORDER.flatMap((tier) => {
      const rows = byTier.get(tier) ?? [];
      if (rows.length === 0) return [];
      const gained = rows.filter((r) => r.actualRatio > 1).length;
      const gained20 = rows.filter((r) => r.actualRatio >= 1.2).length;
      const chaos = summarize(chaosPairs(rows));
      return [
        {
          tier,
          n: rows.length,
          "actually gained %": Math.round((gained / rows.length) * 100),
          "gained 20%+ %": Math.round((gained20 / rows.length) * 100),
          "median actual x": median(rows.map((r) => r.actualRatio)).toFixed(3),
          "dir. accuracy%": Math.round(chaos.directionalAccuracy * 100),
          MAE: chaos.mae.toFixed(3),
        },
      ];
    })
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
