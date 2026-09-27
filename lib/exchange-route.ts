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
import { formatPriceValue, type PriceUnit } from "./price-unit";

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

/** The currency to state a flip's profit in: divines only when both legs trade in divines. */
export function profitUnit(buyIn: LegSource, sellIn: LegSource): PriceUnit {
  return buyIn === "divine" && sellIn === "divine" ? "divine" : "chaos";
}

/** Hover text for a price shown in `unit`: the same amount in the other currency. */
export function otherCurrencyTitle(chaosValue: number, divineValue: number | undefined, unit: PriceUnit): string | undefined {
  if (unit === "divine") return `≈ ${formatPriceValue(chaosValue, divineValue, "chaos")}`;
  return divineValue === undefined ? undefined : `≈ ${formatPriceValue(chaosValue, divineValue, "divine")}`;
}

const TIER_RANK: Record<LiquidityTier, number> = { low: 0, medium: 1, high: 2 };

/** Stock listed on one exchange market during the hour, lowest to highest per side. */
export interface MarketStockRange {
  cards: [number, number];
  currency: [number, number];
  currencyIn: "chaos" | "divine";
}

/** Hover text for a card's Min/Max range. GGG's data has no split of stock by price - only each
 *  side's lowest and highest stock that hour - so that's what this shows. */
export function stockRangeTitle(stock: MarketStockRange | undefined): string | undefined {
  if (!stock) return undefined;
  const range = ([low, high]: [number, number], suffix: string) =>
    low === high ? `${low.toLocaleString()}${suffix}` : `${low.toLocaleString()}–${high.toLocaleString()}${suffix}`;
  return [
    "Stock listed this hour:",
    `${range(stock.cards, "")} cards for sale`,
    `${range(stock.currency, stock.currencyIn === "chaos" ? "c" : "d")} in buy orders`,
  ].join("\n");
}

/** Whether a full stack was ever listed for sale on the market during the hour - an instant buy
 *  needs sellers holding that many cards. Says nothing about price: they could be spread over
 *  several prices, the top ones above the hour's Max. */
export function fullStackListed(stock: MarketStockRange | undefined, stackSize: number): boolean {
  return stock !== undefined && stock.cards[1] >= stackSize;
}

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
