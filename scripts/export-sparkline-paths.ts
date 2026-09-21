/**
 * ML exploration only (not part of the shipped predictor). Exports the RAW 7-point relative log-price path
 * (see lib/prediction-features.ts's sparkToLogPath) alongside the same identity/label columns
 * export-training-features.ts uses, so ml/test_sparkline_cnn.py can test whether a sequence model over the
 * actual path beats the hand-built momentum scalars (mom1/mom3/mom6/vol6/accel/dev_sm3) already in the
 * shipped feature set. Mirage-only, matching the existing validation holdout.
 *
 * Output: ml/cache/tsrows/spark__<label>.f32, row = [t, h, is_cur, shrunk_base, rel_level_pct, path[0..6], y, yd]
 * (11 + 7 = 18 columns). Usage: npx tsx scripts/export-sparkline-paths.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  getCurrencyGrowthRatiosBatch,
  getItemGrowthRatiosBatch,
  PEER_SHRINK_WEIGHT,
  MIN_LEAGUES_WITH_DATA,
  type GrowthRatioRow,
} from "../lib/growth-ratios";
import { allKnownLeagues, CURRENT_LEAGUE } from "../lib/league-recency";
import { itemPriceKey } from "../lib/poe-ninja";
import { sparkToLogPath, SPARK_POINTS } from "../lib/prediction-features";
import { historyNowAtDay, loadLeagueDailyMatrix, valueNearest } from "../lib/history-now";

const T_GRID = [0, 1, 2, 3, 5, 7, 10, 14, 18, 22, 26, 30, 35, 40, 50, 60, 75, 90, 110];
const H_GRID = [1, 2, 3, 5, 7, 10, 14, 20, 30];
const SCENARIOS = T_GRID.flatMap((currentDay) => H_GRID.map((durationDays) => ({ currentDay, durationDays })));
const MAX_DAY = 145;
const CHUNK = 30;
const OUT_DIR = path.join(__dirname, "..", "ml", "cache", "tsrows");
const COLUMNS = ["t", "h", "is_cur", "shrunk_base", "rel_level_pct", ...Array.from({ length: SPARK_POINTS }, (_, i) => `p${i}`), "y", "yd"];

async function exportRun(target: string, excluded: string[], label: string) {
  const outPath = path.join(OUT_DIR, `spark__${label}.f32`);
  const metaPath = path.join(OUT_DIR, `spark__${label}.json`);
  if (fs.existsSync(metaPath) && !process.env.FORCE) {
    console.log(`${label}: exists, skipping`);
    return;
  }
  const t0 = Date.now();
  const minRef = excluded.length === 1 ? MIN_LEAGUES_WITH_DATA : 2;
  const matrix = await loadLeagueDailyMatrix(target, 0, MAX_DAY);
  const nowByDay = new Map<number, ReturnType<typeof historyNowAtDay>>();
  const nowAt = (day: number) => {
    let n = nowByDay.get(day);
    if (!n) nowByDay.set(day, (n = historyNowAtDay(matrix, day)));
    return n;
  };
  const fd = fs.openSync(outPath, "w");
  let rows = 0;

  for (let start = 0; start < SCENARIOS.length; start += CHUNK) {
    const chunk = SCENARIOS.slice(start, start + CHUNK);
    const options = { excludeLeagues: excluded, minLeaguesWithData: minRef, shrinkWeight: PEER_SHRINK_WEIGHT };
    const [curBy, itemBy] = await Promise.all([
      getCurrencyGrowthRatiosBatch(chunk, options),
      getItemGrowthRatiosBatch(chunk, options),
    ]);
    for (let s = 0; s < chunk.length; s++) {
      const { currentDay: t, durationDays: h } = chunk[s];
      if (t + h > matrix.maxDay - 3) continue;
      const now = nowAt(t);
      const rateNow = now.divineRateNow;
      const rateFut = valueNearest(matrix.divineRate, t + h);
      for (const kind of ["currency", "item"] as const) {
        const universe: GrowthRatioRow[] = kind === "currency" ? curBy[s] : itemBy[s];
        // rel_level_pct needs the SAME cross-sectional rank the app uses - recompute it here over this
        // scenario's universe the same way buildFeatureMatrix does (demeaned rank isn't needed for this
        // exploratory test; a plain percentile rank of raw rel_level is a fine proxy signal).
        const nowMap = kind === "currency" ? now.currency : now.items;
        const relLevels: number[] = [];
        const rows_: Array<{ ratio: GrowthRatioRow; priceNow: number; path: number[]; fut: number }> = [];
        for (const ratio of universe) {
          const key = kind === "currency" ? ratio.name : itemPriceKey(ratio.name, ratio.variant);
          const cur = nowMap.get(key);
          if (!cur) continue;
          const series = (kind === "currency" ? matrix.currency : matrix.items).get(key)!;
          const fut = valueNearest(series.values, t + h);
          if (!Number.isFinite(fut)) continue;
          const p = sparkToLogPath(cur.spark);
          if (p.some((v) => !Number.isFinite(v))) continue; // this test needs a COMPLETE 7-point path
          const relLevel = Math.log(cur.priceNow) - ratio.refLevelLog;
          relLevels.push(relLevel);
          rows_.push({ ratio, priceNow: cur.priceNow, path: p, fut });
        }
        if (rows_.length === 0) continue;
        const sorted = [...relLevels].sort((a, b) => a - b);
        // Binary search for the first index >= v, instead of a linear scan - the earlier linear-scan version
        // made this whole export O(n^2) per scenario, which turned an expected few-minute run into 20+ minutes
        // on Settlers' 318-day, dense-scenario grid before it was caught and fixed.
        const pct = (v: number) => {
          let lo = 0,
            hi = sorted.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (sorted[mid] < v) lo = mid + 1;
            else hi = mid;
          }
          return (lo + 1) / sorted.length;
        };

        const out = new Float32Array(rows_.length * COLUMNS.length);
        for (let i = 0; i < rows_.length; i++) {
          const { ratio, priceNow, path: p, fut } = rows_[i];
          const y = Math.log(fut / priceNow);
          const yd = rateNow && Number.isFinite(rateFut) && rateFut > 0 ? y - Math.log(rateFut / rateNow) : NaN;
          const base = i * COLUMNS.length;
          out[base] = t;
          out[base + 1] = h;
          out[base + 2] = kind === "currency" ? 1 : 0;
          out[base + 3] = Math.log(ratio.avgRatio);
          out[base + 4] = pct(Math.log(priceNow) - ratio.refLevelLog);
          for (let k = 0; k < SPARK_POINTS; k++) out[base + 5 + k] = p[k];
          out[base + 5 + SPARK_POINTS] = y;
          out[base + 5 + SPARK_POINTS + 1] = yd;
        }
        fs.writeSync(fd, Buffer.from(out.buffer));
        rows += rows_.length;
      }
    }
    process.stdout.write(`  ${label}: scenarios ${Math.min(start + CHUNK, SCENARIOS.length)}/${SCENARIOS.length}, ${rows.toLocaleString()} rows\r`);
  }
  fs.closeSync(fd);
  fs.writeFileSync(metaPath, JSON.stringify({ label, target, excluded, columns: COLUMNS, rows, minRef }));
  console.log(`\n${label}: ${rows.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const leagues = allKnownLeagues().filter((l) => l !== CURRENT_LEAGUE);
  const holdout = "Mirage";
  for (const t of leagues) await exportRun(t, [t], `full__${t}`);
  for (const t of leagues.filter((l) => l !== holdout)) await exportRun(t, [t, holdout], `nested__${t}__x${holdout}`);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
