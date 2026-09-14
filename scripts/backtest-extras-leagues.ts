// Evaluates a candidate "extras" league (a private/community league that ran inside a main league's
// era - see scripts/ingest-history.ts's INCLUDED_EXTRA_LEAGUES and its comment on why 20 of the 21
// checked so far have no usable data) as additional training data. Never run against the real
// db/history.duckdb the app reads - always against a separate experimental DB, built via the
// POE_DB_PATH override both this script and ingest-history.ts support:
//   POE_DB_PATH=db/history-experiment.duckdb npx tsx scripts/ingest-history.ts   (with the
//     candidate league temporarily added to INCLUDED_EXTRA_LEAGUES)
//   POE_DB_PATH=db/history-experiment.duckdb npx tsx scripts/backtest-extras-leagues.ts
//
// Conclusion from the first (and so far only) candidate, "Necro Settlers" (nested under Settlers,
// ~105 days, ~20% of main Settlers' row volume): flat-to-worse than the 5-league baseline in every
// configuration tested (full weight, half weight, substituted for Settlers, standalone) against both
// the Mirage and Phrecia 2.0 holdouts, driven mostly by a sharp Essence-category regression that
// outweighed a few small gains elsewhere - see the ingest-history.ts comment for the numbers. Left
// out of production training. Update EXTRA_LEAGUE/PARENT_LEAGUE below to re-run this for a future
// candidate.
import {
  getCurrencyGrowthRatiosBatch,
  getItemGrowthRatiosBatch,
  getActualCurrencyValueAtDay,
  getActualItemValueAtDay,
  type GrowthRatioRow,
  type GrowthRatioBatchOptions,
} from "../lib/growth-ratios";
import { getAllCurrentCurrencyPrices } from "../lib/poe-ninja";
import { CURRENT_LEAGUE, allKnownLeagues } from "../lib/league-recency";

const EXTRA_LEAGUE = "Necro Settlers";
const PARENT_LEAGUE = "Settlers"; // the main league Necro Settlers' era overlaps
// Known leagues with no ingested price history at all (the still-active current league) - present
// in allKnownLeagues() for the live app's recency-weighting table, but would just be a confusing
// zero-effect no-op if included in a "training leagues" list here.
const NO_DATA_LEAGUES = ["Allflame"];

const MAX_TOTAL_DAY = 30;
const START_DAYS = [0, 2, 4, 7, 10, 14, 18, 21, 25];
const DURATIONS = [2, 3, 5, 7, 10, 14, 20, 25, 30];
const SCENARIOS: Array<{ currentDay: number; durationDays: number }> = [];
for (const currentDay of START_DAYS) {
  for (const durationDays of DURATIONS) {
    if (currentDay + durationDays <= MAX_TOTAL_DAY) SCENARIOS.push({ currentDay, durationDays });
  }
}

interface MatchedRow {
  key: string;
  category: string;
  predictedRatio: number;
  actualRatio: number;
  predictedRatioDivine?: number;
  actualRatioDivine?: number;
}

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

function directionalAccuracy(pairs: RatioPair[]): number {
  const agree = pairs.filter((p) => (p.predicted >= 1) === (p.actual >= 1)).length;
  return agree / pairs.length;
}

function chaosPairs(rows: MatchedRow[]): RatioPair[] {
  return rows.map((m) => ({ predicted: m.predictedRatio, actual: m.actualRatio }));
}

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
  };
}

function divineRatio(now: number | undefined, future: number | undefined): number | undefined {
  if (now === undefined || future === undefined || now <= 0) return undefined;
  return future / now;
}

async function runScenario(
  holdoutLeague: string,
  currentDay: number,
  durationDays: number,
  currencyRatios: GrowthRatioRow[],
  itemRatios: GrowthRatioRow[],
  currencyTypes: Map<string, { type: string }>
): Promise<MatchedRow[]> {
  const targetDay = currentDay + durationDays;
  const [actualNowCurrency, actualFutureCurrency, actualNowItem, actualFutureItem] = await Promise.all([
    getActualCurrencyValueAtDay(holdoutLeague, currentDay),
    getActualCurrencyValueAtDay(holdoutLeague, targetDay),
    getActualItemValueAtDay(holdoutLeague, currentDay),
    getActualItemValueAtDay(holdoutLeague, targetDay),
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
      actualRatio: actualFutureEntry.value / actualNowEntry.value,
      predictedRatioDivine: trend.avgRatioDivine,
      actualRatioDivine: divineRatio(actualNowEntry.valueDivine, actualFutureEntry.valueDivine),
    });
  }
  return matched;
}

async function runBacktest(
  batchOptions: GrowthRatioBatchOptions,
  currencyTypes: Map<string, { type: string }>
): Promise<MatchedRow[]> {
  const holdoutLeague = batchOptions.excludeLeague!;
  const [currencyByScenario, itemByScenario] = await Promise.all([
    getCurrencyGrowthRatiosBatch(SCENARIOS, batchOptions),
    getItemGrowthRatiosBatch(SCENARIOS, batchOptions),
  ]);
  const allMatched: MatchedRow[] = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    const { currentDay, durationDays } = SCENARIOS[i];
    const matched = await runScenario(
      holdoutLeague,
      currentDay,
      durationDays,
      currencyByScenario[i],
      itemByScenario[i],
      currencyTypes
    );
    if (matched.length < 5) continue;
    allMatched.push(...matched);
  }
  return allMatched;
}

function comparisonRow(label: string, allMatched: MatchedRow[]) {
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

/** weight 1 for the given leagues, 0 for every other known league. */
function onlyLeaguesWeights(leagues: string[]): Map<string, number> {
  return new Map(allKnownLeagues().map((l) => [l, leagues.includes(l) ? 1 : 0]));
}

/** Pooled category breakdown (chaos denomination only), same shape as backtest-mirage.ts's. */
function categoryBreakdown(label: string, rows: MatchedRow[]) {
  const byCategory = new Map<string, MatchedRow[]>();
  for (const row of rows) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }
  return Array.from(byCategory.entries())
    .filter(([, rs]) => rs.length >= 20)
    .map(([category, rs]) => {
      const chaos = summarize(chaosPairs(rs));
      return {
        scheme: label,
        category,
        n: chaos.n,
        spearman: Number(chaos.spearman.toFixed(3)),
        "dir%": Math.round(chaos.directionalAccuracy * 100),
        MAE: Number(chaos.mae.toFixed(3)),
      };
    });
}

/** Runs the full baseline / +full / +half comparison for one holdout league, returning both the
 *  summary rows and the raw matched rows (for a category breakdown) of the baseline and +full runs. */
async function runComparisonsFor(holdoutLeague: string, currencyTypes: Map<string, { type: string }>) {
  const baseTrainingLeagues = allKnownLeagues().filter(
    (l) => l !== holdoutLeague && l !== EXTRA_LEAGUE && !NO_DATA_LEAGUES.includes(l)
  );
  console.log(`\n=== Holdout: ${holdoutLeague} - training on: ${baseTrainingLeagues.join(", ")} ===\n`);

  const rows: Record<string, unknown>[] = [];

  const baseline = await runBacktest(
    { excludeLeague: holdoutLeague, leagueWeights: onlyLeaguesWeights(baseTrainingLeagues) },
    currencyTypes
  );
  rows.push(comparisonRow("baseline (no extras)", baseline));

  const withExtraFull = await runBacktest(
    { excludeLeague: holdoutLeague, leagueWeights: onlyLeaguesWeights([...baseTrainingLeagues, EXTRA_LEAGUE]) },
    currencyTypes
  );
  rows.push(comparisonRow(`+ ${EXTRA_LEAGUE} (full weight)`, withExtraFull));

  const halfWeights = onlyLeaguesWeights([...baseTrainingLeagues, EXTRA_LEAGUE]);
  halfWeights.set(EXTRA_LEAGUE, 0.5);
  const withExtraHalf = await runBacktest({ excludeLeague: holdoutLeague, leagueWeights: halfWeights }, currencyTypes);
  rows.push(comparisonRow(`+ ${EXTRA_LEAGUE} (half weight)`, withExtraHalf));

  console.table(rows);
  return { baseline, withExtraFull };
}

async function main() {
  console.log(`Extras-league discovery: does "${EXTRA_LEAGUE}" help predictions?\n`);
  console.log(`allKnownLeagues(): ${allKnownLeagues().join(", ")}\n`);

  const currencyTypes = await getAllCurrentCurrencyPrices(CURRENT_LEAGUE);

  // --- Primary holdout: Mirage (the established holdout used everywhere else in this project) ---
  console.log("--- Comparison, pooled across every scenario ---");
  const mirageBaseTraining = allKnownLeagues().filter(
    (l) => l !== "Mirage" && l !== EXTRA_LEAGUE && !NO_DATA_LEAGUES.includes(l)
  );
  const rows: Record<string, unknown>[] = [];
  const baseline = await runBacktest(
    { excludeLeague: "Mirage", leagueWeights: onlyLeaguesWeights(mirageBaseTraining) },
    currencyTypes
  );
  rows.push(comparisonRow("baseline (5 leagues, no extras)", baseline));

  const withExtraFull = await runBacktest(
    { excludeLeague: "Mirage", leagueWeights: onlyLeaguesWeights([...mirageBaseTraining, EXTRA_LEAGUE]) },
    currencyTypes
  );
  rows.push(comparisonRow("+ Necro Settlers (full weight)", withExtraFull));

  const halfWeights = onlyLeaguesWeights([...mirageBaseTraining, EXTRA_LEAGUE]);
  halfWeights.set(EXTRA_LEAGUE, 0.5);
  const withExtraHalf = await runBacktest({ excludeLeague: "Mirage", leagueWeights: halfWeights }, currencyTypes);
  rows.push(comparisonRow("+ Necro Settlers (half weight)", withExtraHalf));

  const substituted = mirageBaseTraining.filter((l) => l !== PARENT_LEAGUE);
  const withSubstitution = await runBacktest(
    { excludeLeague: "Mirage", leagueWeights: onlyLeaguesWeights([...substituted, EXTRA_LEAGUE]) },
    currencyTypes
  );
  rows.push(comparisonRow(`Necro Settlers instead of ${PARENT_LEAGUE}`, withSubstitution));

  const alone = await runBacktest(
    { excludeLeague: "Mirage", leagueWeights: onlyLeaguesWeights([EXTRA_LEAGUE]), minLeaguesWithData: 1 },
    currencyTypes
  );
  rows.push(comparisonRow("Necro Settlers alone (n=1 training league)", alone));

  const settlersAlone = await runBacktest(
    { excludeLeague: "Mirage", leagueWeights: onlyLeaguesWeights([PARENT_LEAGUE]), minLeaguesWithData: 1 },
    currencyTypes
  );
  rows.push(comparisonRow(`${PARENT_LEAGUE} alone (n=1 training league)`, settlersAlone));

  console.table(rows);

  // --- Category breakdown: is the (near-)null effect uniform, or does it hide an offsetting split
  // (e.g. helps currency, hurts items)? ---
  console.log("\n--- Category breakdown, chaos denomination, Mirage holdout (>= 20 matched rows only) ---");
  const baselineByCategory = new Map(categoryBreakdown("baseline", baseline).map((r) => [r.category, r]));
  const withExtraByCategory = new Map(categoryBreakdown("+ Necro Settlers", withExtraFull).map((r) => [r.category, r]));
  const categoryComparison = Array.from(baselineByCategory.keys())
    .filter((c) => withExtraByCategory.has(c))
    .map((c) => {
      const before = baselineByCategory.get(c)!;
      const after = withExtraByCategory.get(c)!;
      return {
        category: c,
        n: before.n,
        spearman_before: before.spearman,
        spearman_after: after.spearman,
        spearman_delta: Number((after.spearman - before.spearman).toFixed(3)),
        "dir%_before": before["dir%"],
        "dir%_after": after["dir%"],
      };
    })
    .sort((a, b) => a.spearman_delta - b.spearman_delta);
  console.table(categoryComparison);

  // --- Robustness check: is this pattern specific to the Mirage holdout, or does it hold when
  // predicting a different held-out league too? Phrecia 2.0 is the next most recent training league
  // with a full economy (Keepers/Mercenaries are close in time to Necro Settlers' own era, so
  // Phrecia 2.0 - the most temporally distant - is the more independent check). ---
  await runComparisonsFor("Phrecia 2.0", currencyTypes);

  // --- How much does Necro Settlers actually change avgRatio when added? ---
  // Rather than only look at aggregate metrics, check per-item: for items that exist in both
  // configurations, how far does adding Necro Settlers move the predicted ratio? A large systematic
  // shift with no backtest improvement would suggest the extra league is adding noise, not signal.
  console.log("\n--- How much does adding Necro Settlers move individual predictions? (Mirage holdout) ---");
  const sampleScenario = { currentDay: 4, durationDays: 7 };
  const [baseCurrencyBatch, withCurrencyBatch] = await Promise.all([
    getCurrencyGrowthRatiosBatch([sampleScenario], {
      excludeLeague: "Mirage",
      leagueWeights: onlyLeaguesWeights(mirageBaseTraining),
    }),
    getCurrencyGrowthRatiosBatch([sampleScenario], {
      excludeLeague: "Mirage",
      leagueWeights: onlyLeaguesWeights([...mirageBaseTraining, EXTRA_LEAGUE]),
    }),
  ]);
  const baseMap = new Map(baseCurrencyBatch[0].map((r) => [r.name, r]));
  const withMap = new Map(withCurrencyBatch[0].map((r) => [r.name, r]));
  const shifts: { name: string; before: number; after: number; pctShift: number }[] = [];
  for (const [name, before] of baseMap) {
    const after = withMap.get(name);
    if (!after) continue;
    shifts.push({
      name,
      before: before.avgRatio,
      after: after.avgRatio,
      pctShift: Math.round((after.avgRatio / before.avgRatio - 1) * 100),
    });
  }
  shifts.sort((a, b) => Math.abs(b.pctShift) - Math.abs(a.pctShift));
  console.log(`Scenario day ${sampleScenario.currentDay} -> +${sampleScenario.durationDays}d, currency only, ${shifts.length} items in both.`);
  console.log("Median abs shift:", median(shifts.map((s) => Math.abs(s.pctShift))), "%");
  console.log("Top 10 largest shifts:");
  console.table(
    shifts.slice(0, 10).map((s) => ({
      name: s.name,
      before_x: s.before.toFixed(2),
      after_x: s.after.toFixed(2),
      pct_shift: `${s.pctShift}%`,
    }))
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
