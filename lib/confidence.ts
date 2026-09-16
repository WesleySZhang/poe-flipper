import type { PriceUnit } from "./price-unit";

/**
 * How much to trust a prediction, as distinct from how big it is. A flashy predicted gain resting
 * on one lucky league and a steady one that every past league repeated look identical in the
 * ratio column - this is what separates them.
 *
 * Deliberately answers "how reliably has this gained?", NOT "how precise is the predicted number?".
 * Those diverge: in backtesting, high-confidence rows had *higher* absolute error than low, simply
 * because reliable gainers move further. The question a trader is asking is the former.
 *
 * Validated against the Mirage holdout (see scripts/backtest-mirage.ts's confidence table, which
 * re-checks this on every run): High-tier rows went on to actually gain 71% of the time (median
 * 1.27x), Medium 57%, Low 35% - separates cleanly, so the tier stays meaningful. (Numbers as of
 * peer-group shrinkage on the predicted ratio itself - see growth-ratios.ts's shrinkToPeers -
 * which shifted the exact percentages down a few points from the pre-shrinkage baseline without
 * changing the ordering or the underlying point: confidence tracks something the ratio doesn't.)
 */

// Weights for the three inputs, from strongest to weakest signal in backtesting. Exported so
// scripts/backtest-mirage.ts can sweep them the way it already sweeps league-weighting schemes.
export const DIRECTION_WEIGHT = 0.6;
export const CONSISTENCY_WEIGHT = 0.25;
export const SAMPLE_WEIGHT = 0.15;

/** Log-ratio spread at or above which leagues are treated as fully disagreeing (scores 0 for
 *  consistency). ~0.8 is roughly the 85th percentile of observed spreads. */
export const SPREAD_CEILING = 0.8;
/** Leagues needed to max out the sample-size term - the current training set size. */
export const MAX_EXPECTED_LEAGUES = 5;

export const HIGH_TIER_MIN = 75;
export const MEDIUM_TIER_MIN = 55;

export type ConfidenceTier = "high" | "medium" | "low";

export interface ConfidenceInputs {
  /** Weighted share of past leagues where this actually gained, 0-1. */
  upFraction: number;
  /** Standard deviation of the per-league log ratios - how much the leagues disagreed on magnitude. */
  spread: number;
  /** How many past leagues backed the prediction at all. */
  leagueCount: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Confidence as 0-100. Not a probability - a heuristic ranking score. */
export function confidenceScore({ upFraction, spread, leagueCount }: ConfidenceInputs): number {
  const direction = clamp01(upFraction);
  const consistency = clamp01(1 - Math.abs(spread) / SPREAD_CEILING);
  const sample = clamp01(leagueCount / MAX_EXPECTED_LEAGUES);
  const score =
    DIRECTION_WEIGHT * direction + CONSISTENCY_WEIGHT * consistency + SAMPLE_WEIGHT * sample;
  return Math.round(clamp01(score) * 100);
}

export function confidenceTier(score: number): ConfidenceTier {
  if (score >= HIGH_TIER_MIN) return "high";
  if (score >= MEDIUM_TIER_MIN) return "medium";
  return "low";
}

/** Mirrors activePrice/activeRatio in price-unit.ts: the value to sort by in the selected unit. */
export function activeConfidence(
  chaosScore: number,
  divineScore: number | undefined,
  unit: PriceUnit
): number | undefined {
  return unit === "chaos" ? chaosScore : divineScore;
}

/** Mirrors formatPriceValue/formatRatio: display string, em-dash when there's nothing to show. */
export function formatConfidence(score: number | undefined): string {
  if (score === undefined || !Number.isFinite(score)) return "—";
  return confidenceTier(score) === "high" ? "High" : confidenceTier(score) === "medium" ? "Medium" : "Low";
}

/**
 * Hover text spelling out what the badge is based on, so a tier can't be misread as a probability
 * or as a claim about the predicted number's precision. Shown via the native title attribute, the
 * pattern already used for truncated item names (there's no Tooltip component in components/ui).
 */
export function describeConfidence(
  score: number | undefined,
  upFraction: number | undefined,
  leagueCount: number
): string {
  if (score === undefined || upFraction === undefined) {
    return "Not enough past-league data in this denomination to rate.";
  }
  const gained = Math.round(upFraction * leagueCount);
  return (
    `Confidence ${score}/100 - ${gained} of ${leagueCount} past leagues gained over this window. ` +
    `Reflects how consistently this has risen before, not how exact the predicted price is.`
  );
}
