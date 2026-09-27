/**
 * Picks how to buy and sell for a flip when an item trades on more than one market: against Chaos
 * Orb, against Divine Orb (GGG's Currency Exchange keeps them as separate pairs that don't always
 * agree), or, with no exchange market, at poe.ninja's price. Pure, so the server builds rows with it
 * and components can import the labels.
 *
 * Divine legs are valued in chaos at the hour's Divine Orb rate, so a route that buys with Chaos and
 * sells for Divine (or the reverse) is compared on the same footing as a same-currency one. Ending
 * up holding divines instead of chaos is the only difference; the rate itself moves too.
 */
import type { LiquidityTier } from "./liquidity";

/** Which market a leg trades on. "ninja" = no exchange market, priced at poe.ninja. */
export type LegSource = "chaos" | "divine" | "ninja";

export const LEG_LABEL: Record<LegSource, string> = { chaos: "Chaos", divine: "Divine", ninja: "poe.ninja" };

export interface LegOption {
  source: LegSource;
  /** The leg's total value in chaos (per unit, or per stack/reward for a card flip). */
  chaosValue: number;
  /** The same in divines: exact for a Divine-market leg, converted otherwise. */
  divineValue?: number;
  /** How much real trade backs this leg - see lib/liquidity.ts. */
  tier: LiquidityTier;
}

const TIER_RANK: Record<LiquidityTier, number> = { low: 0, medium: 1, high: 2 };

export function weakerTier(a: LiquidityTier, b: LiquidityTier): LiquidityTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

/**
 * The buy/sell pair to show: the best weaker-leg liquidity first, then the highest sell/buy ratio.
 * Liquidity first so a thinly traded market's rounding noise (Divine quotes for cheap items move in
 * whole-number steps, e.g. 1 div : 5 vs 1 div : 6) never pushes out a route with real volume behind
 * it. Ties keep the earlier option, so list same-currency options first.
 */
export function pickRoute(
  buys: LegOption[],
  sells: LegOption[]
): { buy: LegOption; sell: LegOption; tier: LiquidityTier } | undefined {
  let best: { buy: LegOption; sell: LegOption; tier: LiquidityTier; ratio: number } | undefined;
  for (const buy of buys) {
    if (!(buy.chaosValue > 0)) continue;
    for (const sell of sells) {
      if (!(sell.chaosValue > 0)) continue;
      const tier = weakerTier(buy.tier, sell.tier);
      const ratio = sell.chaosValue / buy.chaosValue;
      const better =
        !best || TIER_RANK[tier] > TIER_RANK[best.tier] || (TIER_RANK[tier] === TIER_RANK[best.tier] && ratio > best.ratio);
      if (better) best = { buy, sell, tier, ratio };
    }
  }
  return best && { buy: best.buy, sell: best.sell, tier: best.tier };
}
