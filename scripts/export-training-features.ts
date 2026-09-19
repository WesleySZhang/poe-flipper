/**
 * Exports training / validation rows for the learned predictor, with every feature computed by the SAME
 * TypeScript code the app runs (lib/growth-ratios.ts + lib/prediction-features.ts + lib/history-now.ts), so
 * the model is trained on exactly what it will be served - no Python re-implementation to drift.
 *
 * For a target league T and an exclusion set E (always containing T), each row is one item at one scenario
 * (league day t, horizon h): the cross-league ratio statistics come from every league NOT in E, "now" is
 * T's own stored price + 7-day sparkline on day t (causal), and the label is what T's price really did.
 *   - final-model rows:  E = [T]      (4 reference leagues; also the test rows when T is the holdout)
 *   - validation rows:   E = [T, H]   (3 reference leagues; the nested exclusion that keeps holdout H
 *                                      out of both features and labels of the model being tested on H)
 *
 * Output: ml/cache/tsrows/<label>.f32 (row-major float32, NaN = missing) + <label>.json (column names, row
 * count). Read by ml/fit_production.py. Usage:
 *   npx tsx scripts/export-training-features.ts                    # holdouts from HOLDOUTS (default Mirage,Keepers)
 *   HOLDOUTS=Mirage npx tsx scripts/export-training-features.ts
 *   FORCE=1 ...                                                    # recompute runs that already exist
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
import { buildFeatureMatrix, FEATURE_NAMES, N_FEATURES, type PredictionInput } from "../lib/prediction-features";
import { historyNowAtDay, loadLeagueDailyMatrix, valueNearest, type HistoryNow } from "../lib/history-now";

// League days and horizons the model is trained on. Dense early (where currency roughly doubles and the
// dispersion between items is widest), sparser late. Rows whose horizon runs past the league's end are skipped.
const T_GRID = [0, 1, 2, 3, 5, 7, 10, 14, 18, 22, 26, 30, 35, 40, 50, 60, 75, 90, 110];
const H_GRID = [1, 2, 3, 5, 7, 10, 14, 20, 30];
const SCENARIOS = T_GRID.flatMap((currentDay) => H_GRID.map((durationDays) => ({ currentDay, durationDays })));
const MAX_DAY = 145;
const CHUNK = 30; // scenarios per batch query (bounds DuckDB's cross-join size)
const ITEM_KEEP = Number(process.env.ITEM_KEEP ?? 0.3); // items are ~99% of rows; keep a random share (ranks use ALL of them)
const OUT_DIR = path.join(__dirname, "..", "ml", "cache", "tsrows");
const COLUMNS = [...FEATURE_NAMES, "y", "yd"];

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

async function exportRun(target: string, excluded: string[], label: string) {
  const metaPath = path.join(OUT_DIR, `${label}.json`);
  if (fs.existsSync(metaPath) && !process.env.FORCE) {
    console.log(`${label}: exists, skipping`);
    return;
  }
  const t0 = Date.now();
  const minRef = excluded.length === 1 ? MIN_LEAGUES_WITH_DATA : 2; // production gate for 4-ref rows; 3-ref validation rows need 2
  const matrix = await loadLeagueDailyMatrix(target, 0, MAX_DAY);
  const nowByDay = new Map<number, ReturnType<typeof historyNowAtDay>>();
  const nowAt = (day: number) => {
    let n = nowByDay.get(day);
    if (!n) nowByDay.set(day, (n = historyNowAtDay(matrix, day)));
    return n;
  };
  const fd = fs.openSync(path.join(OUT_DIR, `${label}.f32`), "w");
  const rng = mulberry32(hash(label));
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
        const inputs: PredictionInput[] = [];
        const hist: HistoryNow[] = [];
        const futures: number[] = [];
        for (const ratio of universe) {
          const key = kind === "currency" ? ratio.name : itemPriceKey(ratio.name, ratio.variant);
          const cur = (kind === "currency" ? now.currency : now.items).get(key);
          if (!cur) continue;
          const series = (kind === "currency" ? matrix.currency : matrix.items).get(key)!;
          inputs.push({ key, kind, ratio, priceNow: cur.priceNow, spark: cur.spark, divineRateNow: rateNow });
          hist.push(cur);
          futures.push(valueNearest(series.values, t + h));
        }
        if (inputs.length === 0) continue;
        const X = buildFeatureMatrix(inputs, { currentDay: t, durationDays: h, universe });
        const out = new Float32Array(inputs.length * COLUMNS.length);
        let kept = 0;
        for (let i = 0; i < inputs.length; i++) {
          const fut = futures[i];
          if (!Number.isFinite(fut)) continue; // no realised outcome -> not a training/validation row (still ranked above)
          if (kind === "item" && rng() > ITEM_KEEP) continue;
          const y = Math.log(fut / inputs[i].priceNow);
          const yd =
            rateNow && Number.isFinite(rateFut) && rateFut > 0 ? y - Math.log(rateFut / rateNow) : NaN;
          const base = kept * COLUMNS.length;
          out.set(X.subarray(i * N_FEATURES, (i + 1) * N_FEATURES), base);
          out[base + N_FEATURES] = y;
          out[base + N_FEATURES + 1] = yd;
          kept++;
        }
        if (kept > 0) {
          fs.writeSync(fd, Buffer.from(out.buffer, 0, kept * COLUMNS.length * 4));
          rows += kept;
        }
      }
    }
    process.stdout.write(`  ${label}: scenarios ${Math.min(start + CHUNK, SCENARIOS.length)}/${SCENARIOS.length}, ${rows.toLocaleString()} rows\r`);
  }
  fs.closeSync(fd);
  fs.writeFileSync(metaPath, JSON.stringify({ label, target, excluded, columns: COLUMNS, rows, minRef, itemKeep: ITEM_KEEP }));
  console.log(`\n${label}: ${rows.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const leagues = allKnownLeagues().filter((l) => l !== CURRENT_LEAGUE);
  const holdouts = (process.env.HOLDOUTS ?? "Mirage,Keepers").split(",").map((s) => s.trim()).filter(Boolean);
  // final-model / holdout-test rows: every league as a target, features from all the others
  for (const t of leagues) await exportRun(t, [t], `full__${t}`);
  // validation training rows: for each holdout H, every other league as a target, with H ALSO excluded
  for (const h of holdouts) for (const t of leagues.filter((l) => l !== h)) await exportRun(t, [t, h], `nested__${t}__x${h}`);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
