import {
  getCurrencyGrowthRatiosBatch,
  getItemGrowthRatiosBatch,
  getActualCurrencyValueAtDay,
  getActualItemValueAtDay,
  type GrowthRatioRow,
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
      actualRatioDivine: divineRatio(actualNowEntry.valueDivine, actualFutureEntry.valueDivine),
    });
  }

  return matched;
}

function divineRatio(now: number | undefined, future: number | undefined): number | undefined {
  if (now === undefined || future === undefined || now <= 0) return undefined;
  return future / now;
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
      console.log(`day ${currentDay} -> +${durationDays}d: only ${matched.length} matched items, skipping`);
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

  console.log(
    `--- Per-scenario results (${perScenarioSummary.length} scenarios with enough data) ---\n` +
      `_chaos = prices measured in chaos (includes chaos debasement); _div = measured in divines\n` +
      `(real value change, debasement divided out).\n`
  );
  console.table(perScenarioSummary);

  const pooledChaos = summarize(chaosPairs(allMatched));
  const pooledDivine = summarize(divinePairs(allMatched));
  console.log("\n--- Chaos vs divine denomination, pooled across every scenario ---");
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
  for (const row of allMatched) {
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
    `\n--- Reliability by category, pooled across all ${SCENARIOS.length} scenarios (>= 20 matched rows only) ---\n` +
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

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
