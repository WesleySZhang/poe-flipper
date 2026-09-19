/**
 * Exports the PRODUCTION model's out-of-sample predictions - one row per (holdout league, scenario,
 * item), paired with what actually happened - to ml/cache/baseline_rows.csv, so the ML experiments
 * in ml/ can be scored on exactly the same rows with exactly the same matching rules as the real
 * model (nearest-day tolerance, minimum-leagues gate, item confidence gate...) rather than a
 * re-implementation of them that could quietly drift. Mirrors scripts/backtest-mirage.ts's
 * cross-league validation loop: every trained league is held out in turn.
 *
 * Usage: npx tsx scripts/export-backtest-baseline.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  getCurrencyGrowthRatiosBatch,
  getItemGrowthRatiosBatch,
  getActualCurrencyValueAtDay,
  getActualItemValueAtDay,
  PEER_SHRINK_WEIGHT,
  type GrowthRatioRow,
} from "../lib/growth-ratios";
import { getAllCurrentCurrencyPrices } from "../lib/poe-ninja";
import { allKnownLeagues, CURRENT_LEAGUE } from "../lib/league-recency";

// Default grid is the same as scripts/backtest-mirage.ts (early league, currentDay + durationDays <= 30).
// SCENARIO_SET=late instead exports later-league scenarios (day 30-110) - where the app currently
// sits and where production's own warning says predictions get unreliable - to ml/cache/baseline_rows_late.csv.
const LATE = process.env.SCENARIO_SET === "late";
const MAX_TOTAL_DAY = LATE ? 133 : 30;
const START_DAYS = LATE ? [30, 35, 40, 50, 60, 75, 90, 110] : [0, 2, 4, 7, 10, 14, 18, 21, 25];
const DURATIONS = LATE ? [3, 7, 14, 21, 30] : [2, 3, 5, 7, 10, 14, 20, 25, 30];
const SCENARIOS: Array<{ currentDay: number; durationDays: number }> = [];
for (const currentDay of START_DAYS) {
  for (const durationDays of DURATIONS) {
    if (currentDay + durationDays <= MAX_TOTAL_DAY) SCENARIOS.push({ currentDay, durationDays });
  }
}

const HEADER = [
  "holdout",
  "kind",
  "current_day",
  "duration",
  "key",
  "category",
  "pred_ratio",
  "pred_ratio_div",
  "league_count",
  "confidence",
  "actual_now",
  "actual_future",
  "actual_ratio",
  "actual_ratio_div",
];

function csvField(v: string | number | undefined): string {
  if (v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const currencyTypes = await getAllCurrentCurrencyPrices(CURRENT_LEAGUE);
  const holdouts = allKnownLeagues().filter((l) => l !== CURRENT_LEAGUE);
  const outDir = path.join(__dirname, "..", "ml", "cache");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, LATE ? "baseline_rows_late.csv" : "baseline_rows.csv");
  const out = fs.createWriteStream(outPath);
  out.write(HEADER.join(",") + "\n");

  let total = 0;
  for (const holdout of holdouts) {
    const options = { excludeLeague: holdout, shrinkWeight: PEER_SHRINK_WEIGHT };
    const [currencyByScenario, itemByScenario] = await Promise.all([
      getCurrencyGrowthRatiosBatch(SCENARIOS, options),
      getItemGrowthRatiosBatch(SCENARIOS, options),
    ]);

    for (let i = 0; i < SCENARIOS.length; i++) {
      const { currentDay, durationDays } = SCENARIOS[i];
      const targetDay = currentDay + durationDays;
      const [nowC, futC, nowI, futI] = await Promise.all([
        getActualCurrencyValueAtDay(holdout, currentDay),
        getActualCurrencyValueAtDay(holdout, targetDay),
        getActualItemValueAtDay(holdout, currentDay),
        getActualItemValueAtDay(holdout, targetDay),
      ]);

      const emit = (
        kind: "currency" | "item",
        key: string,
        category: string,
        trend: GrowthRatioRow,
        now: { value: number; valueDivine?: number },
        fut: { value: number; valueDivine?: number }
      ) => {
        const actualDiv = now.valueDivine && fut.valueDivine !== undefined ? fut.valueDivine / now.valueDivine : undefined;
        out.write(
          [
            holdout,
            kind,
            currentDay,
            durationDays,
            key,
            category,
            trend.avgRatio,
            trend.avgRatioDivine,
            trend.leagueCount,
            trend.confidence,
            now.value,
            fut.value,
            fut.value / now.value,
            actualDiv,
          ]
            .map(csvField)
            .join(",") + "\n"
        );
        total++;
      };

      for (const trend of currencyByScenario[i]) {
        const now = nowC.get(trend.name);
        const fut = futC.get(trend.name);
        if (!now || !fut || now.value <= 0) continue;
        emit("currency", trend.name, currencyTypes.get(trend.name)?.type ?? "Currency", trend, now, fut);
      }
      for (const trend of itemByScenario[i]) {
        const key = trend.variant ? `${trend.name}::${trend.variant}` : trend.name;
        const now = nowI.get(key);
        const fut = futI.get(key);
        if (!now || !fut || now.value <= 0) continue;
        emit("item", key, now.type ?? fut.type ?? "Unknown", trend, now, fut);
      }
    }
    console.log(`${holdout}: done (running total ${total} rows)`);
  }
  await new Promise<void>((resolve) => out.end(resolve));
  console.log(`Wrote ${total} rows to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
