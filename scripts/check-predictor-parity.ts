/**
 * Proves the TypeScript predictor runtime (lib/prediction-model.ts) reproduces the Python-trained model:
 * loads ml/cache/tsrows/model_holdout_<H>.json (written by ml/fit_production.py), scores the parity rows
 * Python saved (features exactly as the app's own feature code produced them) and compares against Python's
 * predictions for the same rows - XGBoost trees and the formula tables, chaos and divine.
 *
 *   npx tsx scripts/check-predictor-parity.ts [holdout]     (default Mirage)
 */
import fs from "node:fs";
import path from "node:path";
import { createPredictor, scoreFeatureMatrix, type PredictorModel } from "../lib/prediction-model";
import { FEATURE_NAMES, N_FEATURES } from "../lib/prediction-features";

function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => {
    const idx = v.map((_, i) => i).sort((x, y) => v[x] - v[y]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
      for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n, mb = rb.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}

async function main() {
  const holdout = process.argv[2] ?? "Mirage";
  const dir = path.join(__dirname, "..", "ml", "cache", "tsrows");
  const model = JSON.parse(fs.readFileSync(path.join(dir, `model_holdout_${holdout}.json`), "utf8")) as PredictorModel;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `parity_${holdout}.json`), "utf8"));
  const raw = fs.readFileSync(path.join(dir, `parity_${holdout}.f32`));
  const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const columns: string[] = meta.columns;
  const n: number = meta.rows;
  if (JSON.stringify(columns.slice(0, N_FEATURES)) !== JSON.stringify([...FEATURE_NAMES])) {
    throw new Error("column order differs between ml/fit_production.py and lib/prediction-features.ts");
  }
  const stride = columns.length;
  const X = new Float32Array(n * N_FEATURES);
  const y: number[] = [], t: number[] = [];
  for (let i = 0; i < n; i++) {
    X.set(all.subarray(i * stride, i * stride + N_FEATURES), i * N_FEATURES);
    y.push(all[i * stride + N_FEATURES]);
    t.push(all[i * stride]);
  }
  const rt = createPredictor(model);
  const xg = scoreFeatureMatrix(X, "xgb", rt);
  const fm = scoreFeatureMatrix(X, "formula", rt);
  const clip = model.clip;
  const cmp = (name: string, ts: Float64Array, py: Array<number | null>) => {
    let max = 0, n = 0, mismatchedNaN = 0;
    for (let i = 0; i < py.length; i++) {
      const p = py[i];
      if (p === null || Number.isNaN(ts[i])) { if ((p === null) !== Number.isNaN(ts[i])) mismatchedNaN++; continue; }
      max = Math.max(max, Math.abs(ts[i] - Math.min(clip, Math.max(-clip, p))));
      n++;
    }
    console.log(`${name.padEnd(16)} rows compared ${String(n).padStart(6)}  max |TS - Python| = ${max.toExponential(2)}  NaN-status mismatches: ${mismatchedNaN}`);
    return max;
  };
  const worst = Math.max(
    cmp("xgb chaos", xg.chaos, meta.xgb_chaos),
    cmp("xgb divine", xg.divine, meta.xgb_divine),
    cmp("formula chaos", fm.chaos, meta.formula_chaos)
  );
  // end-to-end sanity: rank correlation with what actually happened, per scenario size class
  const ok = y.map((v) => Number.isFinite(v));
  const rho = spearman(y.filter((_, i) => ok[i]), Array.from(xg.chaos).filter((_, i) => ok[i]));
  console.log(`\n${n} rows from ${new Set(t).size} league days; pooled Spearman(TS xgb chaos, actual y) = ${rho.toFixed(3)}`);
  console.log(worst < 1e-4 ? "PARITY OK" : "PARITY FAILED");
  process.exitCode = worst < 1e-4 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
