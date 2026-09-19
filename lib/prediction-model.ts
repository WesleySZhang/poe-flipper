/**
 * Runtime for the learned growth predictor. Trained offline (ml/fit_production.py, on rows exported by
 * scripts/export-training-features.ts, i.e. on features built by lib/prediction-features.ts) and shipped as
 * a plain JSON file (lib/models/predictor.json). Two interchangeable predictors, plus the old behaviour:
 *
 *   "xgb"      gradient-boosted trees (200 x depth 8), evaluated by the ~15-line walker below. Best accuracy.
 *   "formula"  a small table of linear coefficients per league-day bucket x kind. Cheaper, nearly as good in
 *              the first days of a league, where XGBoost's advantage is smallest.
 *   "baseline" the original recency-flat, peer-shrunk average of past leagues' growth ratios, unchanged.
 *
 * Selected by the PREDICTOR env var (default "xgb"); a missing/empty model file falls back to the formula, then
 * to baseline, so the app never breaks on a model problem. Everything is CPU-only and dependency-free - it runs
 * on a plain serverless function (100 ms for ~14k rows at 200 trees, measured; see ml/README.md).
 */
import predictorJson from "./models/predictor.json";
import { buildFeatureMatrix, FEATURE_INDEX, N_FEATURES, type FeatureContext, type FeatureName, type PredictionInput } from "./prediction-features";

export type PredictorMode = "baseline" | "formula" | "xgb";

/** Items priced under this many chaos are price-tick noise (0.03c -> 0.05c is "+67%"), not flips, and the model is
 *  neither trained nor validated on them - they keep the production ratio. Mirrors growth-ratios.ts's item floor. */
export const MIN_ITEM_PRICE_FOR_MODEL = 1;

/** One linear model: prediction = intercept + sum coef_i * clip((x_i - mu_i) / sd_i, -6, 6), missing x_i -> 0. */
export interface FormulaBucket {
  kind: "currency" | "item";
  tMin: number;
  tMax: number;
  cols: FeatureName[];
  mu: number[];
  sd: number[];
  coef: number[];
  intercept: number;
}

/** A tree ensemble packed as base64 typed arrays (compact + trivial to parse; see ml/fit_production.py). */
export interface PackedForest {
  baseScore: number;
  cols: FeatureName[];
  roots: string; // Int32 - index of each tree's root node
  f: string; // Int16 - feature index into `cols`, -1 for a leaf
  c: string; // Float32 - split threshold, or the leaf value for a leaf
  l: string; // Int32 - left child (taken when x < threshold), -1 for a leaf
  r: string; // Int32 - right child
  d: string; // Uint8 - 1 if a missing value goes left
}

export interface PredictorModel {
  version: number;
  trainedOn: string;
  /** Log-return predictions are clamped to +-clip (the training labels were, too). */
  clip: number;
  formula: { chaos: FormulaBucket[]; divine: FormulaBucket[] };
  xgb: { chaos?: PackedForest; divine?: PackedForest };
}

function unpack<T extends Int16Array | Int32Array | Float32Array | Uint8Array>(
  b64: string,
  ctor: { new (buffer: ArrayBuffer): T }
): T {
  const buf = Buffer.from(b64, "base64");
  return new ctor(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

class Forest {
  private readonly roots: Int32Array;
  private readonly feature: Int16Array; // GLOBAL feature column per node (resolved once), -1 for leaves
  private readonly value: Float32Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  private readonly defaultLeft: Uint8Array;
  private readonly baseScore: number;

  constructor(p: PackedForest) {
    this.roots = unpack(p.roots, Int32Array);
    const local = unpack(p.f, Int16Array);
    this.feature = local.map((idx) => (idx < 0 ? -1 : FEATURE_INDEX[p.cols[idx]]));
    this.value = unpack(p.c, Float32Array);
    this.left = unpack(p.l, Int32Array);
    this.right = unpack(p.r, Int32Array);
    this.defaultLeft = unpack(p.d, Uint8Array);
    this.baseScore = p.baseScore;
  }

  predictRow(x: Float32Array, off: number): number {
    const { roots, feature, value, left, right, defaultLeft } = this;
    let sum = this.baseScore;
    for (let t = 0; t < roots.length; t++) {
      let n = roots[t];
      while (left[n] !== -1) {
        const v = x[off + feature[n]];
        n = Number.isNaN(v) ? (defaultLeft[n] ? left[n] : right[n]) : v < value[n] ? left[n] : right[n];
      }
      sum += value[n];
    }
    return sum;
  }
}

function formulaPredict(buckets: FormulaBucket[], X: Float32Array, row: number, t: number, isCur: boolean): number {
  const kind = isCur ? "currency" : "item";
  let b = buckets.find((k) => k.kind === kind && t >= k.tMin && t <= k.tMax);
  if (!b) {
    // beyond the last trained day range: use the latest bucket for this kind
    const ofKind = buckets.filter((k) => k.kind === kind);
    b = ofKind[ofKind.length - 1];
  }
  if (!b) return NaN;
  let sum = b.intercept;
  for (let i = 0; i < b.cols.length; i++) {
    const v = X[row * N_FEATURES + FEATURE_INDEX[b.cols[i]]];
    if (Number.isNaN(v)) continue; // standardised missing = 0 contribution
    sum += b.coef[i] * Math.min(6, Math.max(-6, (v - b.mu[i]) / b.sd[i]));
  }
  return sum;
}

export interface PredictorRuntime {
  model: PredictorModel;
  chaos?: Forest;
  divine?: Forest;
}

export function createPredictor(model: PredictorModel): PredictorRuntime {
  return {
    model,
    chaos: model.xgb.chaos?.roots ? new Forest(model.xgb.chaos) : undefined,
    divine: model.xgb.divine?.roots ? new Forest(model.xgb.divine) : undefined,
  };
}

let defaultRuntime: PredictorRuntime | undefined;
function getDefaultRuntime(): PredictorRuntime {
  return (defaultRuntime ??= createPredictor(predictorJson as unknown as PredictorModel));
}

/** The mode requested via PREDICTOR (default xgb), downgraded to whatever the loaded model can actually do. */
export function resolveMode(requested: string | undefined, rt: PredictorRuntime = getDefaultRuntime()): PredictorMode {
  const want: PredictorMode = requested === "baseline" || requested === "formula" || requested === "xgb" ? requested : "xgb";
  if (want === "xgb" && rt.chaos) return "xgb";
  if ((want === "xgb" || want === "formula") && rt.model.formula.chaos.length > 0) return "formula";
  return "baseline";
}

export function currentPredictorMode(): PredictorMode {
  return resolveMode(process.env.PREDICTOR);
}

export interface GrowthPrediction {
  /** Predicted price ratio (future / now) in chaos. */
  ratio: number;
  /** Same, divine-denominated (chaos debasement divided out); undefined when the divine ratio is unavailable. */
  ratioDivine?: number;
}

/**
 * Scores a feature matrix (row-major, N_FEATURES wide - see buildFeatureMatrix) and returns the predicted LOG
 * returns, clamped to +-clip; NaN where the predictor cannot score a row (the divine score is also NaN for a
 * row with no divine-denominated features). Exposed so tests can score exported training rows directly.
 */
export function scoreFeatureMatrix(
  X: Float32Array,
  mode: Exclude<PredictorMode, "baseline">,
  rt: PredictorRuntime = getDefaultRuntime()
): { chaos: Float64Array; divine: Float64Array } {
  const n = X.length / N_FEATURES;
  const { clip } = rt.model;
  const clamp = (v: number) => Math.min(clip, Math.max(-clip, v));
  const shrunkDiv = FEATURE_INDEX.shrunk_div, isCur = FEATURE_INDEX.is_cur, tCol = FEATURE_INDEX.t;
  const chaos = new Float64Array(n).fill(NaN), divine = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const off = i * N_FEATURES;
    const hasDivine = !Number.isNaN(X[off + shrunkDiv]);
    if (mode === "xgb" && rt.chaos) {
      chaos[i] = clamp(rt.chaos.predictRow(X, off));
      if (hasDivine && rt.divine) divine[i] = clamp(rt.divine.predictRow(X, off));
    } else {
      chaos[i] = clamp(formulaPredict(rt.model.formula.chaos, X, i, X[off + tCol], X[off + isCur] === 1));
      if (hasDivine) divine[i] = clamp(formulaPredict(rt.model.formula.divine, X, i, X[off + tCol], X[off + isCur] === 1));
    }
  }
  return { chaos, divine };
}

// Identical inputs (e.g. repeated requests inside poe.ninja's 20-minute response cache) give identical
// predictions - reuse the last few instead of re-walking every tree.
const memo = new Map<string, GrowthPrediction[]>();
const MEMO_LIMIT = 6;

function fingerprint(X: Float32Array, mode: string): string {
  let h1 = 2166136261, h2 = 5381;
  const u = new Uint32Array(X.buffer, X.byteOffset, X.length);
  for (let i = 0; i < u.length; i++) {
    h1 = Math.imul(h1 ^ u[i], 16777619);
    h2 = (Math.imul(h2, 33) + u[i]) | 0;
  }
  return `${mode}:${X.length}:${h1 >>> 0}:${h2 >>> 0}`;
}

/**
 * Predicts the growth ratio for every input, in order. In "baseline" mode returns the stored production ratios
 * untouched. `ctx.universe` must be the full cross-league ratio set for the scenario (see FeatureContext).
 */
export function predictGrowth(
  inputs: PredictionInput[],
  ctx: FeatureContext,
  mode: PredictorMode = currentPredictorMode(),
  rt: PredictorRuntime = getDefaultRuntime()
): GrowthPrediction[] {
  if (mode === "baseline" || inputs.length === 0) {
    return inputs.map((i) => ({ ratio: i.ratio.avgRatio, ratioDivine: i.ratio.avgRatioDivine }));
  }
  const X = buildFeatureMatrix(inputs, ctx);
  const sig = rt === defaultRuntime ? fingerprint(X, mode) : undefined;
  const cached = sig ? memo.get(sig) : undefined;
  if (cached) return cached;

  const scores = scoreFeatureMatrix(X, mode, rt);
  const out: GrowthPrediction[] = new Array(inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    const { chaos, divine } = { chaos: scores.chaos[i], divine: scores.divine[i] };
    // A predictor that cannot score a row, or a sub-floor item, falls back to the production ratio for that row.
    if (inputs[i].kind === "item" && inputs[i].priceNow < MIN_ITEM_PRICE_FOR_MODEL) {
      out[i] = { ratio: inputs[i].ratio.avgRatio, ratioDivine: inputs[i].ratio.avgRatioDivine };
      continue;
    }
    out[i] = {
      ratio: Number.isFinite(chaos) ? Math.exp(chaos) : inputs[i].ratio.avgRatio,
      ratioDivine: inputs[i].ratio.avgRatioDivine === undefined ? undefined : Number.isFinite(divine) ? Math.exp(divine) : inputs[i].ratio.avgRatioDivine,
    };
  }
  if (sig) {
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value as string);
    memo.set(sig, out);
  }
  return out;
}
