/**
 * End-to-end out-of-sample check of the shipped prediction path: replays the finished Mirage league through
 * lib/mirage-simulator.ts (the app's own code - live-style features from stored history, cross-sectional ranks,
 * predictGrowth, actual outcomes) with a model trained WITHOUT Mirage, once per predictor, and scores
 * production vs formula vs XGBoost on the scenarios' realised price ratios.
 *
 *   npx tsx --conditions=react-server scripts/backtest-predictor.ts [model.json] [league-day list]
 *   (the react-server condition lets this script import the "server-only" simulator module)
 * Needs ml/cache/tsrows/model_holdout_Mirage.json from `python ml/fit_production.py validate`.
 */
import fs from "node:fs";
import path from "node:path";
import { simulateMirageLeague } from "../lib/mirage-simulator";
import { createPredictor, type PredictorMode, type PredictorModel } from "../lib/prediction-model";

function ranks(v: number[]): number[] {
  const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
  const r = new Array<number>(v.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
    for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function spearman(a: number[], b: number[]): number {
  const ra = ranks(a), rb = ranks(b), n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n, mb = rb.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}

async function main() {
  const modelPath = process.argv[2] ?? path.join(__dirname, "..", "ml", "cache", "tsrows", "model_holdout_Mirage.json");
  const rt = createPredictor(JSON.parse(fs.readFileSync(modelPath, "utf8")) as PredictorModel);
  const days = (process.argv[3] ?? "0,3,7,14,21,30,50,75").split(",").map(Number);
  const durations = [3, 7, 14];
  const modes: Array<[string, PredictorMode]> = [["production", "baseline"], ["formula", "formula"], ["xgb", "xgb"]];
  const acc: Record<string, { rho: number[]; hit: number[]; top: number[]; byDay: Record<number, number[]> }> = {};
  for (const [name] of modes) acc[name] = { rho: [], hit: [], top: [], byDay: {} };

  for (const day of days) {
    for (const dur of durations) {
      for (const [name, mode] of modes) {
        const rows = await simulateMirageLeague(day, dur, { mode, runtime: rt });
        for (const kind of ["currency", "item"] as const) {
          const r = rows.filter((x) => x.category === kind && x.actualRatio > 0 && Number.isFinite(x.predictedRatio));
          if (r.length < 30) continue;
          const y = r.map((x) => Math.log(x.actualRatio));
          const p = r.map((x) => Math.log(x.predictedRatio));
          const rho = spearman(p, y);
          const order = r.map((_, i) => i).sort((a, b) => p[b] - p[a]).slice(0, Math.max(5, Math.floor(r.length * 0.1)));
          acc[name].rho.push(rho);
          acc[name].hit.push(order.filter((i) => y[i] > 0).length / order.length);
          acc[name].top.push(order.reduce((s, i) => s + y[i], 0) / order.length);
          (acc[name].byDay[day] ??= []).push(rho);
        }
      }
      process.stdout.write(`  day ${day} +${dur}d done\r`);
    }
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log("\nMirage replay through lib/mirage-simulator.ts (model trained without Mirage), per-scenario means:");
  console.log("predictor   Spearman   top-10% hit   top-10% mean log-return");
  for (const [name] of modes) {
    const a = acc[name];
    console.log(`${name.padEnd(11)} ${mean(a.rho).toFixed(3).padStart(8)}   ${(mean(a.hit) * 100).toFixed(1).padStart(9)}%   ${mean(a.top).toFixed(3).padStart(12)}   (n=${a.rho.length} scenario-kinds)`);
  }
  console.log("\nSpearman by league day:  " + days.map((d) => `day ${d}`).join("  |  "));
  for (const [name] of modes) console.log(`${name.padEnd(11)} ` + days.map((d) => mean(acc[name].byDay[d] ?? [NaN]).toFixed(3).padStart(7)).join("  |  "));
}

main().then(() => { process.exitCode = 0; }).catch((e) => { console.error(e); process.exitCode = 1; });
