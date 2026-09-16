/**
 * How much real trade backs a Currency Exchange spread, as distinct from how wide the spread looks.
 * A huge percentage on a barely-traded item is usually just ratio-rounding noise (integer ratios
 * make a cheap stack-priced item's "spread" explode from a single unlucky trade), not a real
 * opportunity - see components/currency-exchange-flip-panel.tsx's header caption.
 */
export type LiquidityTier = "high" | "medium" | "low";

// Thresholds on chaos volume traded in the last closed hour (not stock) - chosen from the live
// spread of values actually observed across a real league's markets (a few dozen up to hundreds of
// thousands), not an arbitrary round number. "High" means real, fillable volume; "low" means the
// spread you're looking at might just be one or two trades' worth of noise.
export const LIQUIDITY_HIGH_MIN = 10000;
export const LIQUIDITY_MEDIUM_MIN = 1000;

export function liquidityTier(volumeChaos: number): LiquidityTier {
  if (volumeChaos >= LIQUIDITY_HIGH_MIN) return "high";
  if (volumeChaos >= LIQUIDITY_MEDIUM_MIN) return "medium";
  return "low";
}
