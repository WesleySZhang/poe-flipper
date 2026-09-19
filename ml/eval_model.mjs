// Minimal XGBoost tree-ensemble evaluator (regression, numeric features, missing -> default direction).
// Proves the exported model can be scored in plain JS on a serverless function: checks parity with XGBoost's
// own predictions and times inference. Run: node ml/eval_model.mjs
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const dir = new URL("./cache/export/", import.meta.url);
const model = JSON.parse(readFileSync(new URL("port_model.json", dir), "utf8"));
const parity = JSON.parse(readFileSync(new URL("parity.json", dir), "utf8"));

const F = Int16Array.from(model.f);
const C = Float32Array.from(model.c);
const L = Int32Array.from(model.l);
const R = Int32Array.from(model.r);
const D = Uint8Array.from(model.d);
const roots = Int32Array.from(model.roots);
const nFeat = model.features.length;

function predictRow(x, off, base) {
  let sum = base;
  for (let t = 0; t < roots.length; t++) {
    let n = roots[t];
    while (L[n] !== -1) {
      const v = x[off + F[n]];
      n = Number.isNaN(v) ? (D[n] ? L[n] : R[n]) : v < C[n] ? L[n] : R[n];
    }
    sum += C[n];
  }
  return sum;
}

// pack rows into a Float32Array (NaN for missing), as production would
const rows = parity.rows;
const X = new Float32Array(rows.length * nFeat);
rows.forEach((r, i) => r.forEach((v, j) => (X[i * nFeat + j] = v === null ? NaN : v)));

const out = new Float64Array(rows.length);
const run = () => {
  for (let i = 0; i < rows.length; i++) out[i] = predictRow(X, i * nFeat, model.base_score);
};
run(); // warm-up (JIT)
let maxDiff = 0;
for (let i = 0; i < rows.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - parity.py[i]));
console.log(`rows ${rows.length}, trees ${roots.length}, nodes ${model.f.length}`);
const diffs = Array.from(out, (v, i) => Math.abs(v - parity.py[i])).sort((a, b) => a - b);
const q = (p) => diffs[Math.floor(p * (diffs.length - 1))];
console.log(`parity vs XGBoost: max |diff| = ${maxDiff.toExponential(2)}, median ${q(0.5).toExponential(1)}, p99 ${q(0.99).toExponential(1)}, rows with diff > 1e-3: ${diffs.filter((d) => d > 1e-3).length}`);

const reps = 20;
const t0 = performance.now();
for (let k = 0; k < reps; k++) run();
const ms = (performance.now() - t0) / reps;
console.log(`inference: ${ms.toFixed(1)} ms for ${rows.length} rows (${((ms / rows.length) * 1000).toFixed(1)} us/row), avg of ${reps} runs`);

// cold path: first call after parse, no JIT warm-up (what a fresh serverless instance pays once)
const cold = new Float64Array(rows.length);
const c0 = performance.now();
for (let i = 0; i < rows.length; i++) cold[i] = predictRow(X, i * nFeat, model.base_score);
console.log(`first (cold) pass: ${(performance.now() - c0).toFixed(1)} ms`);

const raw = readFileSync(new URL("port_model.json", dir));
console.log(`model file: ${(raw.length / 1e6).toFixed(2)} MB raw, ${(gzipSync(raw, { level: 9 }).length / 1e6).toFixed(2)} MB gzip`);
const t1 = performance.now();
JSON.parse(raw.toString("utf8"));
console.log(`JSON.parse of the model file: ${(performance.now() - t1).toFixed(1)} ms (once per cold start)`);
