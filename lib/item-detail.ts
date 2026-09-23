import "server-only";
import { itemPriceKey } from "./poe-ninja";
import { getCurrencyPricesPreferSnapshot, getItemPricesPreferSnapshot } from "./price-snapshot";
import { getFaustusSpreads, isFaustusTradeable, type FaustusSpread } from "./faustus";
import { liquidityTier, type LiquidityTier } from "./liquidity";
import { momentumFromPath, sparkToLogPath } from "./prediction-features";

/** Log-space momentum stats straight from lib/prediction-features.ts's own model-input math (see
 *  that file's momentumFromPath) - the same numbers the learned model itself sees, not a separate
 *  metric invented for display. mom1/mom3/mom6 are log(now/then); exponentiate to a %-change at
 *  render time (this module stays in the same units the rest of the prediction pipeline uses). */
export interface ItemMomentum {
  mom1: number;
  mom3: number;
  mom6: number;
  vol6: number;
  accel: number;
  dev_sm3: number;
}

/**
 * Everything about an item's CURRENT live snapshot that FlipSuggestion doesn't carry (see
 * lib/flip-suggestions.ts) - poe.ninja's raw seller count/sparkline, and GGG's Currency Exchange
 * spread/volume/stock/gold cost for the small evergreen currency subset it covers. Deliberately
 * independent of any "Days ahead" duration - none of this changes with the chosen forecast window,
 * unlike price/ratio/confidence (see components/item-detail-panel.tsx for how those are fetched
 * instead, reusing the exact same precomputed-predictions machinery the main table already has).
 */
export interface ItemDetail {
  category: "currency" | "item";
  historyName: string;
  variant?: string;
  /** poe.ninja's own category bucket (SkillGem, Scarab, Currency, ...) - see ItemPrice.type/CurrencyPrice.type. */
  filterCategory: string;
  /** Today's live price, independent of any prediction - see this interface's own doc. Shown in the
   *  Overview even when there's no FlipSuggestion for the chosen duration (see components/
   *  item-detail-panel.tsx), which is a real, expected state for an item whose past leagues are too
   *  short to support a longer-duration forecast (see lib/flip-suggestions.ts's growth-ratio
   *  matching) - that's "no PREDICTION for this duration", not "no live price", and the two used to
   *  be conflated into one misleading "no live price" message. */
  currentChaosValue: number;
  currentDivineValue?: number;
  /** Items only - how many distinct people are currently selling this exact name+variant. */
  sellerCount?: number;
  spark?: Array<number | null>;
  momentum?: ItemMomentum;
  /** Currency only, and only when GGG's exchange had a market for it this hour - see lib/faustus.ts. */
  faustus?: FaustusSpread;
  liquidity?: LiquidityTier;
}

/** Undefined when poe.ninja simply isn't pricing this item/currency right now - same "skip, don't
 *  fabricate" rule the rest of this app follows for missing live prices. */
export async function getItemDetail(
  league: string,
  category: "currency" | "item",
  historyName: string,
  variant: string | undefined
): Promise<ItemDetail | undefined> {
  if (category === "currency") {
    const tradeable = isFaustusTradeable(historyName);
    const [prices, spreads] = await Promise.all([
      getCurrencyPricesPreferSnapshot(league),
      // Skip the whole exchange-market fetch when this name could never be in it anyway - same
      // guard lib/flip-suggestions.ts's own faustusTradeable field already uses.
      tradeable ? getFaustusSpreads(league) : Promise.resolve<FaustusSpread[]>([]),
    ]);
    const price = prices.get(historyName);
    if (!price) return undefined;

    const divineRate = prices.get("Divine Orb")?.chaosValue;
    const faustus = spreads.find((s) => s.name === historyName);
    return {
      category,
      historyName,
      filterCategory: price.type,
      currentChaosValue: price.chaosValue,
      currentDivineValue: divineRate ? price.chaosValue / divineRate : undefined,
      spark: price.spark,
      momentum: price.spark ? momentumFromPath(sparkToLogPath(price.spark)) : undefined,
      faustus,
      liquidity: faustus ? liquidityTier(faustus.volumeChaos) : undefined,
    };
  }

  const [prices, currencyPrices] = await Promise.all([
    getItemPricesPreferSnapshot(league),
    // Only needed for Divine Orb's own chaos rate, to derive currentDivineValue the same way
    // lib/flip-suggestions.ts's buildSuggestion does - not fetched for its own item data.
    getCurrencyPricesPreferSnapshot(league),
  ]);
  const price = prices.get(itemPriceKey(historyName, variant));
  if (!price) return undefined;

  const divineRate = currencyPrices.get("Divine Orb")?.chaosValue;
  return {
    category,
    historyName,
    variant,
    filterCategory: price.type,
    currentChaosValue: price.chaosValue,
    currentDivineValue: divineRate ? price.chaosValue / divineRate : undefined,
    sellerCount: price.sellerCount,
    spark: price.spark,
    momentum: price.spark ? momentumFromPath(sparkToLogPath(price.spark)) : undefined,
  };
}
