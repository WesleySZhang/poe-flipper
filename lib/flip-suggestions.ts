import "server-only";
import { getAllCurrentCurrencyPrices, getAllCurrentItemPrices, itemPriceKey, formatItemDisplayName } from "./poe-ninja";
import { getCurrencyGrowthRatios, getItemGrowthRatios, type GrowthRatioRow } from "./growth-ratios";

export interface FlipSuggestion {
  name: string;
  category: "currency" | "item";
  /** What the category filter groups by: the item's or currency's poe.ninja type bucket (SkillGem, Scarab, Currency, ...). */
  filterCategory: string;
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
  const [currencyTrends, itemTrends, currencyPrices, itemPrices] = await Promise.all([
    getCurrencyGrowthRatios({ currentDay, durationDays, excludeLeague: league }),
    getItemGrowthRatios({ currentDay, durationDays, excludeLeague: league }),
    getAllCurrentCurrencyPrices(league),
    getAllCurrentItemPrices(league),
  ]);

  // Expensive items are really priced (by traders) in Divine Orbs, not chaos - a chaos-only price
  // for one of those drifts with the Divine Orb exchange rate (which inflates a lot over a league)
  // as much as with the item's own value, which is misleading. Divine Orb's own live chaos price is
  // just another entry in currencyPrices, fetched the same way as everything else.
  const divineRate = currencyPrices.get("Divine Orb")?.chaosValue;

  const suggestions: FlipSuggestion[] = [];

  for (const trend of currencyTrends) {
    const price = currencyPrices.get(trend.name);
    if (price === undefined || price.chaosValue <= 0) continue;
    suggestions.push(buildSuggestion(trend, "currency", price.type, price.chaosValue, durationDays, divineRate));
  }

  for (const trend of itemTrends) {
    const itemPrice = itemPrices.get(itemPriceKey(trend.name, trend.variant));
    if (itemPrice !== undefined && itemPrice.chaosValue > 0) {
      suggestions.push(buildSuggestion(trend, "item", itemPrice.type, itemPrice.chaosValue, durationDays, divineRate));
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
