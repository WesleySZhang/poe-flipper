import "server-only";
import { getAllCurrentCurrencyPrices, getAllCurrentItemPrices, itemPriceKey, formatItemDisplayName } from "./poe-ninja";
import { getCurrencyGrowthRatios, getItemGrowthRatios, type GrowthRatioRow } from "./growth-ratios";
import { getFaustusPrices, isFaustusTradeable } from "./faustus";

// Guards against one specific failure mode: a rare item/variant (a corrupted 21/23% quality gem, an
// influence-exalted base) with only a handful of live sellers, where the historical training data
// swung wildly (e.g. 1.08x in one league, 8.94x in another) purely because one seller repriced it -
// not a real trend. Deliberately gated on BOTH a thin live market AND an extreme predicted ratio,
// not liquidity alone: an earlier version of this filter used only a seller-count floor and turned
// out to remove ~42% of all item suggestions (3000+ perfectly ordinary, modest predictions) - most
// niche gear/gem variants simply always have few concurrent sellers, which is normal and not a sign
// of anything wrong, so liquidity by itself was far too broad a signal. Restricting to also require
// an extreme ratio targets just the actual problem: of the ~10.6k current predictions, only 15
// (0.14%) show a >100% predicted swing, and all but 2 of those have 1-4 live sellers right now.
// Currency has no equivalent check - poe.ninja's currency overview has no per-line seller count, and
// bulk currency essentially never produces this kind of swing anyway.
const MIN_ITEM_SELLER_COUNT_FOR_EXTREME_RATIO = 5;
// "Extreme" here means outside a 2x/0.5x band - roughly the same territory the ~15 flagged rows
// occupied (all >=2x), with the low end mirrored for symmetry (a thin market can crash the same way
// it can spike).
const EXTREME_RATIO_HIGH = 2;
const EXTREME_RATIO_LOW = 0.5;

function isThinMarketOutlier(ratio: number, sellerCount: number | undefined): boolean {
  if (sellerCount === undefined || sellerCount >= MIN_ITEM_SELLER_COUNT_FOR_EXTREME_RATIO) return false;
  return ratio > EXTREME_RATIO_HIGH || ratio < EXTREME_RATIO_LOW;
}

export interface FlipSuggestion {
  name: string;
  category: "currency" | "item";
  /** What the category filter groups by: the item's or currency's poe.ninja type bucket (SkillGem, Scarab, Currency, ...). */
  filterCategory: string;
  /** Whether GGG's Currency Exchange (Faustus) covers this exact name at all - see lib/faustus.ts.
   *  Only ever true for a small, evergreen currency subset; drives whether the "Faustus Price"
   *  on-demand button renders for this row at all. */
  faustusTradeable: boolean;
  currentChaosValue: number;
  /** Undefined only if the live Divine Orb price itself couldn't be fetched. */
  currentDivineValue?: number;
  predictedChaosValue: number;
  predictedDivineValue?: number;
  avgGrowthRatio: number;
  /** Growth with chaos debasement divided out - see GrowthRatioRow.avgRatioDivine. */
  avgGrowthRatioDivine?: number;
  leagueCount: number;
  /** Leagues backing the divine-denominated figures - can be lower than leagueCount, so the
   *  confidence hover quotes the right denominator in divine mode. */
  leagueCountDivine: number;
  /** How reliably this has gained before, 0-100 - see lib/confidence.ts. */
  confidence: number;
  confidenceDivine?: number;
  /** Share of past leagues that gained, for the "N of M leagues" hover text. */
  upFraction: number;
  upFractionDivine?: number;
  rationale: string;
}

function buildSuggestion(
  trend: GrowthRatioRow,
  category: "currency" | "item",
  filterCategory: string,
  currentChaosValue: number,
  durationDays: number,
  divineRate: number | undefined
): FlipSuggestion {
  const pctChange = Math.round((trend.avgRatio - 1) * 100);
  const direction = pctChange >= 0 ? "risen" : "fallen";
  const displayName = formatItemDisplayName(trend.name, trend.variant);
  const currentDivineValue = divineRate ? currentChaosValue / divineRate : undefined;
  return {
    name: displayName,
    category,
    filterCategory,
    // Faustus/Currency Exchange only ever covers plain evergreen currencies (see
    // FAUSTUS_NAME_TO_ID) - guarding on category defends against a coincidental name collision with
    // an item/unique, even though isFaustusTradeable would already return false for those today.
    faustusTradeable: category === "currency" && isFaustusTradeable(trend.name),
    currentChaosValue,
    currentDivineValue,
    predictedChaosValue: currentChaosValue * trend.avgRatio,
    // Grown by the divine-denominated ratio rather than converting the chaos prediction at today's
    // rate - the chaos prediction already includes however much chaos is expected to debase over
    // the window, so converting it at today's rate would double-count that inflation.
    predictedDivineValue:
      currentDivineValue !== undefined && trend.avgRatioDivine !== undefined
        ? currentDivineValue * trend.avgRatioDivine
        : undefined,
    avgGrowthRatio: trend.avgRatio,
    avgGrowthRatioDivine: trend.avgRatioDivine,
    leagueCount: trend.leagueCount,
    leagueCountDivine: trend.leagueCountDivine,
    confidence: trend.confidence,
    confidenceDivine: trend.confidenceDivine,
    upFraction: trend.upFraction,
    upFractionDivine: trend.upFractionDivine,
    rationale: `Historically has ${direction} ${Math.abs(pctChange)}% over the next ${durationDays} days from this point in the league, averaged over ${trend.leagueCount} past leagues.`,
  };
}

/**
 * Ranks items/currency by projected growth from the current league day over the given duration.
 * Returns every matching row (no top-N cap) - the UI paginates and category-filters client-side,
 * and capping here would silently hide whole categories whenever one category's ratios dominate.
 */
export async function getFlipSuggestions(
  league: string,
  currentDay: number,
  durationDays: number
): Promise<FlipSuggestion[]> {
  const [currencyTrends, itemTrends, currencyPrices, itemPrices, faustusPrices] = await Promise.all([
    getCurrencyGrowthRatios({ currentDay, durationDays, excludeLeague: league }),
    getItemGrowthRatios({ currentDay, durationDays, excludeLeague: league }),
    getAllCurrentCurrencyPrices(league),
    getAllCurrentItemPrices(league),
    getFaustusPrices(league),
  ]);

  // Expensive items are really priced (by traders) in Divine Orbs, not chaos - a chaos-only price
  // for one of those drifts with the Divine Orb exchange rate (which inflates a lot over a league)
  // as much as with the item's own value, which is misleading. Divine Orb's own live chaos price is
  // just another entry in currencyPrices, fetched the same way as everything else - falls back to
  // Faustus on the same terms as every other currency below, though in practice Divine Orb is about
  // the least likely price to ever be missing from poe.ninja.
  const divineRate = currencyPrices.get("Divine Orb")?.chaosValue ?? faustusPrices.get("Divine Orb")?.chaosValue;

  const suggestions: FlipSuggestion[] = [];

  for (const trend of currencyTrends) {
    const price = currencyPrices.get(trend.name);
    if (price !== undefined && price.chaosValue > 0) {
      suggestions.push(buildSuggestion(trend, "currency", price.type, price.chaosValue, durationDays, divineRate));
      continue;
    }
    // poe.ninja hasn't listed a live price for this currency at all yet (common for a brand-new or
    // low-volume item early in a league) - GGG's own Currency Exchange (Faustus) trade data covers a
    // small, evergreen subset of currencies (see lib/faustus.ts) and can fill this gap when it does.
    const faustusPrice = faustusPrices.get(trend.name);
    if (faustusPrice !== undefined && faustusPrice.chaosValue > 0) {
      suggestions.push(buildSuggestion(trend, "currency", "Currency", faustusPrice.chaosValue, durationDays, divineRate));
    }
  }

  for (const trend of itemTrends) {
    const itemPrice = itemPrices.get(itemPriceKey(trend.name, trend.variant));
    if (itemPrice !== undefined && itemPrice.chaosValue > 0) {
      // See isThinMarketOutlier above - skip rather than fall through to the currency-price
      // fallback below, which prices a completely different set of items (Scarabs/Essences/etc.)
      // and wouldn't legitimately apply to this same trend.
      if (!isThinMarketOutlier(trend.avgRatio, itemPrice.sellerCount)) {
        suggestions.push(buildSuggestion(trend, "item", itemPrice.type, itemPrice.chaosValue, durationDays, divineRate));
      }
      continue;
    }
    // Scarabs/Essences/Fossils/Oils/Omens/Resonators/Tattoos/DeliriumOrbs/DivinationCards are
    // categorized as items in the ingested history (item_history.type) but poe.ninja has since moved
    // their live prices onto the currency endpoint (see CURRENCY_OVERVIEW_TYPES) - fall back to the
    // currency price map, keyed on name only since these never have a variant.
    const currencyPrice = !trend.variant ? currencyPrices.get(trend.name) : undefined;
    if (currencyPrice !== undefined && currencyPrice.chaosValue > 0) {
      suggestions.push(
        buildSuggestion(trend, "item", currencyPrice.type, currencyPrice.chaosValue, durationDays, divineRate)
      );
    }
  }

  return suggestions.sort((a, b) => b.avgGrowthRatio - a.avgGrowthRatio);
}
