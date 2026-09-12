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

/** Fraction of rows where the prediction and reality agree on direction (both a rise or both a fall). */
function directionalAccuracy(rows: MatchedRow[]): number {
  const agree = rows.filter((m) => (m.predictedRatio >= 1) === (m.actualRatio >= 1)).length;
  return agree / rows.length;
}

function summarize(rows: MatchedRow[]) {
  const predicted = rows.map((m) => m.predictedRatio);
  const actual = rows.map((m) => m.actualRatio);
  const absErrors = rows.map((m) => Math.abs(m.predictedRatio - m.actualRatio));
  return {
    n: rows.length,
    pearson: pearson(predicted, actual),
    spearman: spearman(predicted, actual),
    mae: mean(absErrors),
    medianAe: median(absErrors),
    directionalAccuracy: directionalAccuracy(rows),
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
    if (actualNow === undefined || actualFuture === undefined || actualNow <= 0) continue;
    matched.push({
      key: trend.name,
      category: currencyTypes.get(trend.name)?.type ?? "Currency",
      predictedRatio: trend.avgRatio,
      leagueCount: trend.leagueCount,
      actualNow,
      actualFuture,
      actualRatio: actualFuture / actualNow,
    });
  }

  for (const trend of itemRatios) {
    const key = trend.variant ? `${trend.name}::${trend.variant}` : trend.name;
    const actualNowEntry = actualNowItem.get(key);
    const actualFutureEntry = actualFutureItem.get(key);
    const actualNow = actualNowEntry?.value;
    const actualFuture = actualFutureEntry?.value;
    if (actualNow === undefined || actualFuture === undefined || actualNow <= 0) continue;
    matched.push({
      key,
      category: actualNowEntry?.type ?? actualFutureEntry?.type ?? "Unknown",
      predictedRatio: trend.avgRatio,
      leagueCount: trend.leagueCount,
      actualNow,
      actualFuture,
      actualRatio: actualFuture / actualNow,
    });
  }

  return matched;
}

async function main() {
  console.log(
    `Backtesting flip-suggestion model against holdout league "${HOLDOUT_LEAGUE}" (excluded from training).\n` +
      `${SCENARIOS.length} scenarios, all with currentDay + durationDays <= ${MAX_TOTAL_DAY}. High-confidence data only.\n`
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
    const s = summarize(matched);
    perScenarioSummary.push({
      "day -> +Nd": `${currentDay} -> +${durationDays}d`,
      n: s.n,
      pearson_r: s.pearson.toFixed(3),
      spearman_r: s.spearman.toFixed(3),
      MAE: s.mae.toFixed(3),
      "dir. accuracy%": Math.round(s.directionalAccuracy * 100),
      "avg predicted x": s.avgPredictedX.toFixed(2),
      "avg actual x": s.avgActualX.toFixed(2),
    });
  }

  console.log(`--- Per-scenario results (${perScenarioSummary.length} scenarios with enough data) ---`);
  console.table(perScenarioSummary);

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
      const s = summarize(rows);
      return {
        category,
        n: s.n,
        pearson_r: s.pearson,
        spearman_r: s.spearman,
        MAE: s.mae,
        medianAE: s.medianAe,
        "dir. accuracy%": Math.round(s.directionalAccuracy * 100),
        "avg predicted x": s.avgPredictedX,
        "avg actual x": s.avgActualX,
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
      pearson_r: c.pearson_r.toFixed(3),
      spearman_r: c.spearman_r.toFixed(3),
      MAE: c.MAE.toFixed(3),
      medianAE: c.medianAE.toFixed(3),
      "dir. accuracy%": c["dir. accuracy%"],
      "avg predicted x": c["avg predicted x"].toFixed(2),
      "avg actual x": c["avg actual x"].toFixed(2),
    }))
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
