/**
 * End-to-end out-of-sample check of the shipped prediction path: replays a finished league (Mirage by default)
 * through lib/mirage-simulator.ts (the app's own code - live-style features from stored history, cross-sectional
 * ranks, predictGrowth, actual outcomes) with a model trained WITHOUT that league, once per predictor, and scores
 * production vs formula vs XGBoost on the scenarios' realised price ratios.
 *
 *   npx tsx --conditions=react-server scripts/backtest-predictor.ts [model.json] [league-day list] [--league <League>]
 *   (the react-server condition lets this script import the "server-only" simulator module)
 * Default model: ml/cache/tsrows/model_holdout_<League>.json from `python ml/fit_production.py validate`. Any model
 * that never trained on the league works, e.g. the predictor.json shipped before the league was added.
 * Scenarios whose target day runs past the league's last stored day minus 3 are skipped, so a late scenario can't
 * be scored against a price the simulator's nearest-day lookup pulled from days earlier.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../lib/db";
import { SIMULATED_LEAGUE } from "../lib/mirage-league";
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
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** Slope of actual on predicted: 1 = predicted moves are the right size, < 1 = too big, > 1 = too small. */
function slope(p: number[], y: number[]): number {
  const mp = mean(p), my = mean(y);
  let c = 0, v = 0;
  for (let i = 0; i < p.length; i++) { c += (p[i] - mp) * (y[i] - my); v += (p[i] - mp) ** 2; }
  return v > 0 ? c / v : NaN;
}

async function lastDay(league: string): Promise<number> {
  const db = await getDb();
  const r = await db.runAndReadAll("SELECT MAX(day_offset) FROM currency_history_dayed WHERE league = $league", { league });
  return Number(r.getRows()[0][0]);
}

async function main() {
  const args = process.argv.slice(2);
  const li = args.indexOf("--league");
  const league = li !== -1 ? args.splice(li, 2)[1] : SIMULATED_LEAGUE;
  const modelPath = args[0] ?? path.join(__dirname, "..", "ml", "cache", "tsrows", `model_holdout_${league}.json`);
  const rt = createPredictor(JSON.parse(fs.readFileSync(modelPath, "utf8")) as PredictorModel);
  const days = (args[1] ?? "0,3,7,14,21,30,50,75").split(",").map(Number);
  const durations = [3, 7, 14];
  const maxDay = await lastDay(league);
  const modes: Array<[string, PredictorMode]> = [["production", "baseline"], ["formula", "formula"], ["xgb", "xgb"]];
  type Acc = { rho: number[]; hit: number[]; top: number[]; slope: number[]; topPred: number[]; topAct: number[]; byDay: Record<number, number[]> };
  const acc: Record<string, Acc> = {};
  for (const [name] of modes) acc[name] = { rho: [], hit: [], top: [], slope: [], topPred: [], topAct: [], byDay: {} };
  console.log(`Replaying ${league} (last stored day ${maxDay}) with ${path.basename(modelPath)}`);

  for (const day of days) {
    for (const dur of durations) {
      if (day + dur > maxDay - 3) continue;
      for (const [name, mode] of modes) {
        const rows = await simulateMirageLeague(day, dur, { mode, runtime: rt, league });
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
          acc[name].slope.push(slope(p, y));
          acc[name].topPred.push(median(order.map((i) => p[i])));
          acc[name].topAct.push(median(order.map((i) => y[i])));
          (acc[name].byDay[day] ??= []).push(rho);
        }
      }
      process.stdout.write(`  day ${day} +${dur}d done\r`);
    }
  }
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${((Math.exp(x) - 1) * 100).toFixed(0)}%`;
  console.log(`\n${league} replay through lib/mirage-simulator.ts (model trained without ${league}), per-scenario means:`);
  console.log("predictor   Spearman   top-10% hit   top-10% mean log-return   slope   top-10% median: predicted -> actual");
  for (const [name] of modes) {
    const a = acc[name];
    const finite = (v: number[]) => v.filter(Number.isFinite);
    console.log(
      `${name.padEnd(11)} ${mean(a.rho).toFixed(3).padStart(8)}   ${(mean(a.hit) * 100).toFixed(1).padStart(9)}%   ${mean(a.top).toFixed(3).padStart(12)}` +
        `              ${mean(finite(a.slope)).toFixed(2).padStart(5)}   ${pct(mean(a.topPred)).padStart(7)} -> ${pct(mean(a.topAct))}   (n=${a.rho.length} scenario-kinds)`
    );
  }
  const shown = days.filter((d) => d + durations[0] <= maxDay - 3);
  console.log("\nSpearman by league day:  " + shown.map((d) => `day ${d}`).join("  |  "));
  for (const [name] of modes) console.log(`${name.padEnd(11)} ` + shown.map((d) => mean(acc[name].byDay[d] ?? [NaN]).toFixed(3).padStart(7)).join("  |  "));
}

main().then(() => { process.exitCode = 0; }).catch((e) => { console.error(e); process.exitCode = 1; });
