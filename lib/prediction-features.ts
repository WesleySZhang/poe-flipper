/**
 * Feature construction for the learned growth predictor (lib/prediction-model.ts) - the ONE place these
 * numbers are computed, used identically by
 *   - the live app (inputs: poe.ninja's live price + 7-day sparkline),
 *   - the mirage simulator and the training-data export (inputs: the same two things read from a league's
 *     stored daily history, see lib/history-now.ts),
 * so a model trained on exported rows is scored on features built exactly the way it was trained
 * (see ml/README.md, "Deployment footprint": a Python re-implementation of these drifted; this cannot).
 *
 * Pure functions, no I/O, no server-only import (scripts use it too).
 */
import type { GrowthRatioRow } from "./growth-ratios";

/** Model input columns, in the order lib/models/predictor.json was trained on. The chaos and divine models
 *  read different subsets (see the *_COLUMNS lists), but every row carries all of them. */
export const FEATURE_NAMES = [
  "t", "h", "is_cur",
  "n_ref", "ref_mean", "ref_std", "ref_up", "peer_ref_mean", "shrunk_base",
  "x_now", "rel_level", "rel_level_pct", "rel_level_w", // rel_level(_w/_div): demeaned across the market, see demeanByKind
  "mom1", "mom3", "mom6", "vol6", "accel", "dev_sm3", "mom6_pct", "peer_mom6",
  // divine-denominated counterparts (NaN when too few leagues had a divine rate)
  "n_ref_div", "refd_mean", "refd_std", "refd_up", "peer_refd_mean", "shrunk_div", "x_now_div", "rel_level_div",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export const FEATURE_INDEX: Record<FeatureName, number> = Object.fromEntries(
  FEATURE_NAMES.map((n, i) => [n, i])
) as Record<FeatureName, number>;
export const N_FEATURES = FEATURE_NAMES.length;

/** Number of points in poe.ninja's sparkline. Points are days t-6 .. t. */
export const SPARK_POINTS = 7;

/** One item's inputs for one prediction. `key` is only an opaque handle for the caller. */
export interface PredictionInput {
  key: string;
  kind: "currency" | "item";
  /** Cross-league statistics for this item, from lib/growth-ratios.ts (same scenario, same exclusions). */
  ratio: GrowthRatioRow;
  /** Live (or replayed) chaos price now. Must be > 0. */
  priceNow: number;
  /** Chaos per Divine now, for the divine-denominated features. Undefined -> those features are NaN. */
  divineRateNow?: number;
  /** poe.ninja-style sparkline (percent change vs a fixed base, oldest first, null = missing day), or undefined. */
  spark?: Array<number | null>;
}

const clip = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Sparkline (percent changes vs a fixed base) -> log-price path RELATIVE to its last point, i.e. path[6] = 0
 * and path[i] = log(p_i / p_now). Only ratios of points matter, so the (unknown) base cancels. Null / invalid
 * points and a missing last point become NaN. Always returns SPARK_POINTS entries, oldest first.
 */
export function sparkToLogPath(spark: Array<number | null> | undefined): number[] {
  const path = new Array<number>(SPARK_POINTS).fill(NaN);
  if (!spark || spark.length < 2) return path;
  // Right-align: the last sparkline point is "now" even if the response carries fewer/more than 7 points.
  const pts = spark.slice(-SPARK_POINTS);
  const offset = SPARK_POINTS - pts.length;
  const last = pts[pts.length - 1];
  if (last === null || !(1 + last / 100 > 0)) return path;
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i];
    if (v !== null && 1 + v / 100 > 0) path[offset + i] = Math.log((1 + v / 100) / (1 + last / 100));
  }
  return path;
}

interface Momentum {
  mom1: number; mom3: number; mom6: number; vol6: number; accel: number; dev_sm3: number;
}

/** Momentum features from a relative log path (see sparkToLogPath). mom_k = log(p_now / p_{now-k}). */
export function momentumFromPath(path: number[]): Momentum {
  const at = (back: number) => path[SPARK_POINTS - 1 - back];
  const mom = (k: number) => {
    const v = at(k);
    return Number.isFinite(v) ? -v : NaN; // path is log(p_i/p_now), so log(p_now/p_i) = -path
  };
  const mom1 = mom(1), mom3 = mom(3), mom6 = mom(6);
  // realised volatility of the daily log changes over the window (population std, over available consecutive pairs)
  const diffs: number[] = [];
  for (let i = 1; i < SPARK_POINTS; i++) if (Number.isFinite(path[i]) && Number.isFinite(path[i - 1])) diffs.push(path[i] - path[i - 1]);
  let vol6 = NaN;
  if (diffs.length > 0) {
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    vol6 = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length);
  }
  // how far "now" sits above its own last-3-point average (a short-lived spike tends to fade)
  const last3 = [path[SPARK_POINTS - 3], path[SPARK_POINTS - 2], path[SPARK_POINTS - 1]].filter(Number.isFinite);
  const dev_sm3 = last3.length > 0 ? -(last3.reduce((a, b) => a + b, 0) / last3.length) : NaN;
  return { mom1, mom3, mom6, vol6, accel: mom3 - (mom6 - mom3), dev_sm3 };
}

/** Average-rank percentile in (0, 1] over the finite entries; NaN stays NaN. Matches pandas rank(pct=True). */
export function percentileRanks(values: number[]): number[] {
  const idx: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) idx.push(i);
  idx.sort((a, b) => values[a] - values[b]);
  const out = new Array<number>(values.length).fill(NaN);
  const n = idx.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1]] === values[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based average rank of the tie group
    for (let k = i; k <= j; k++) out[idx[k]] = avgRank / n;
    i = j + 1;
  }
  return out;
}

function median(values: number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Subtracts the cross-sectional median (per kind) from a level-vs-history feature. A whole league's chaos prices
 * sit above or below past leagues' on the same day whenever chaos itself is debased more or less (Allflame day
 * 57: Divine = 358c vs 130-144c in three past leagues, so EVERY item looks ~2.5x "expensive"). That is a
 * league-wide offset, not information about any one item, and a model trained on a few leagues would misread it
 * as "overpriced, will fall" - so only an item's level RELATIVE TO THE REST OF THE MARKET is used.
 */
function demeanByKind(values: number[], kinds: Array<"currency" | "item">): number[] {
  const med = { currency: median(values.filter((_, i) => kinds[i] === "currency")), item: median(values.filter((_, i) => kinds[i] === "item")) };
  return values.map((v, i) => (Number.isFinite(med[kinds[i]]) ? v - med[kinds[i]] : v));
}

/** Weighted mean of `values` grouped by `groups`, weights `weights` (NaN values are skipped). */
function groupWeightedMean(groups: string[], values: number[], weights: number[]): Map<string, number> {
  const sum = new Map<string, number>(), wsum = new Map<string, number>();
  for (let i = 0; i < groups.length; i++) {
    if (!Number.isFinite(values[i]) || !(weights[i] > 0)) continue;
    sum.set(groups[i], (sum.get(groups[i]) ?? 0) + weights[i] * values[i]);
    wsum.set(groups[i], (wsum.get(groups[i]) ?? 0) + weights[i]);
  }
  const out = new Map<string, number>();
  for (const [g, s] of sum) out.set(g, s / (wsum.get(g) as number));
  return out;
}

export interface FeatureContext {
  /** League day treated as "now" and how many days ahead is being predicted. */
  currentDay: number;
  durationDays: number;
  /** The FULL cross-league ratio universe for this scenario (every row lib/growth-ratios.ts returned, not just
   *  those with a live price): peer-group means are taken over it, exactly as shrinkToPeers does. */
  universe: GrowthRatioRow[];
}

/**
 * Builds one N_FEATURES-wide row per input (returned as a flat Float32Array, row-major, NaN for "unknown").
 * Cross-sectional features (percentile ranks, peer momentum) are computed among `inputs` - i.e. among the items
 * that actually have a price now - separately for currency and items, as the model was trained.
 */
export function buildFeatureMatrix(inputs: PredictionInput[], ctx: FeatureContext): Float32Array {
  const n = inputs.length;
  const X = new Float32Array(n * N_FEATURES).fill(NaN);

  // Peer means of the UN-shrunk log ratio over the whole ratio universe, weighted by league count - the same
  // numbers shrinkToPeers blends toward (so shrunk_base = 0.5*ref_mean + 0.5*peer_ref_mean holds exactly).
  const uni = ctx.universe;
  const peer = groupWeightedMean(uni.map((r) => r.peerCategory), uni.map((r) => r.rawLogRatio), uni.map((r) => r.leagueCount));
  const uniDiv = uni.filter((r) => r.rawLogRatioDivine !== undefined);
  const peerDiv = groupWeightedMean(
    uniDiv.map((r) => r.peerCategory),
    uniDiv.map((r) => r.rawLogRatioDivine as number),
    uniDiv.map((r) => r.leagueCountDivine)
  );

  const kinds = inputs.map((i) => i.kind);
  const rawRelLevel = new Array<number>(n).fill(NaN), rawRelLevelDiv = new Array<number>(n).fill(NaN);
  const moms: Momentum[] = [];
  for (let i = 0; i < n; i++) {
    const inp = inputs[i], r = inp.ratio;
    moms.push(momentumFromPath(sparkToLogPath(inp.spark)));
    rawRelLevel[i] = Math.log(inp.priceNow) - r.refLevelLog;
    if (inp.divineRateNow && inp.divineRateNow > 0 && r.refLevelLogDivine !== undefined) {
      rawRelLevelDiv[i] = Math.log(inp.priceNow) - Math.log(inp.divineRateNow) - r.refLevelLogDivine;
    }
  }
  const relLevel = demeanByKind(rawRelLevel, kinds);
  const relLevelDiv = demeanByKind(rawRelLevelDiv, kinds);
  // cross-sectional ranks, per kind
  const relLevelPct = new Array<number>(n).fill(NaN), mom6Pct = new Array<number>(n).fill(NaN);
  const peerMom6 = new Array<number>(n).fill(NaN);
  for (const kind of ["currency", "item"] as const) {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) if (inputs[i].kind === kind) ids.push(i);
    const rl = percentileRanks(ids.map((i) => relLevel[i]));
    const m6 = percentileRanks(ids.map((i) => moms[i].mom6));
    const pm = groupWeightedMean(ids.map((i) => inputs[i].ratio.peerCategory), ids.map((i) => moms[i].mom6), ids.map(() => 1));
    ids.forEach((i, k) => {
      relLevelPct[i] = rl[k];
      mom6Pct[i] = m6[k];
      peerMom6[i] = pm.get(inputs[i].ratio.peerCategory) ?? NaN;
    });
  }

  const put = (row: number, name: FeatureName, v: number) => { X[row * N_FEATURES + FEATURE_INDEX[name]] = v; };
  for (let i = 0; i < n; i++) {
    const inp = inputs[i], r = inp.ratio, m = moms[i];
    const xNow = Math.log(inp.priceNow);
    put(i, "t", ctx.currentDay);
    put(i, "h", ctx.durationDays);
    put(i, "is_cur", inp.kind === "currency" ? 1 : 0);
    put(i, "n_ref", r.leagueCount);
    put(i, "ref_mean", r.rawLogRatio);
    put(i, "ref_std", r.ratioSpread ?? NaN);
    put(i, "ref_up", r.upFraction);
    put(i, "peer_ref_mean", peer.get(r.peerCategory) ?? NaN);
    put(i, "shrunk_base", Math.log(r.avgRatio));
    put(i, "x_now", xNow);
    put(i, "rel_level", relLevel[i]);
    put(i, "rel_level_pct", relLevelPct[i]);
    put(i, "rel_level_w", clip(relLevel[i], -2, 2));
    put(i, "mom1", m.mom1);
    put(i, "mom3", m.mom3);
    put(i, "mom6", m.mom6);
    put(i, "vol6", m.vol6);
    put(i, "accel", m.accel);
    put(i, "dev_sm3", m.dev_sm3);
    put(i, "mom6_pct", mom6Pct[i]);
    put(i, "peer_mom6", peerMom6[i]);
    if (r.avgRatioDivine !== undefined && r.rawLogRatioDivine !== undefined && inp.divineRateNow && inp.divineRateNow > 0) {
      const xNowDiv = xNow - Math.log(inp.divineRateNow);
      put(i, "n_ref_div", r.leagueCountDivine);
      put(i, "refd_mean", r.rawLogRatioDivine);
      put(i, "refd_std", r.ratioSpreadDivine ?? NaN);
      put(i, "refd_up", r.upFractionDivine ?? NaN);
      put(i, "peer_refd_mean", peerDiv.get(r.peerCategory) ?? NaN);
      put(i, "shrunk_div", Math.log(r.avgRatioDivine));
      put(i, "x_now_div", xNowDiv);
      put(i, "rel_level_div", relLevelDiv[i]);
    }
  }
  return X;
}
