import "server-only";
import { getAllCurrentCurrencyPrices, getAllCurrentItemPrices, itemPriceKey, formatItemDisplayName } from "./poe-ninja";
import { getCurrencyGrowthRatios, getItemGrowthRatios, type GrowthRatioRow } from "./growth-ratios";

export interface FlipSuggestion {
  name: string;
  category: "currency" | "item";
  /** What the category filter groups by: the item's or currency's poe.ninja type bucket (SkillGem, Scarab, Currency, ...). */
  filterCategory: string;
  currentChaosValue: number;
  predictedChaosValue: number;
  avgGrowthRatio: number;
  leagueCount: number;
  rationale: string;
}

function buildSuggestion(
  trend: GrowthRatioRow,
  category: "currency" | "item",
  filterCategory: string,
  currentChaosValue: number,
  durationDays: number
): FlipSuggestion {
  const pctChange = Math.round((trend.avgRatio - 1) * 100);
  const direction = pctChange >= 0 ? "risen" : "fallen";
  const displayName = formatItemDisplayName(trend.name, trend.variant);
  return {
    name: displayName,
    category,
    filterCategory,
    currentChaosValue,
    predictedChaosValue: currentChaosValue * trend.avgRatio,
    avgGrowthRatio: trend.avgRatio,
    leagueCount: trend.leagueCount,
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

  const suggestions: FlipSuggestion[] = [];

  for (const trend of currencyTrends) {
    const price = currencyPrices.get(trend.name);
    if (price === undefined || price.chaosValue <= 0) continue;
    suggestions.push(buildSuggestion(trend, "currency", price.type, price.chaosValue, durationDays));
  }

  for (const trend of itemTrends) {
    const itemPrice = itemPrices.get(itemPriceKey(trend.name, trend.variant));
    if (itemPrice !== undefined && itemPrice.chaosValue > 0) {
      suggestions.push(buildSuggestion(trend, "item", itemPrice.type, itemPrice.chaosValue, durationDays));
      continue;
    }
    // Scarabs/Essences/Fossils/Oils/Omens/Resonators/Tattoos/DeliriumOrbs/DivinationCards are
    // categorized as items in the ingested history (item_history.type) but poe.ninja has since moved
    // their live prices onto the currency endpoint (see CURRENCY_OVERVIEW_TYPES) - fall back to the
    // currency price map, keyed on name only since these never have a variant.
    const currencyPrice = !trend.variant ? currencyPrices.get(trend.name) : undefined;
    if (currencyPrice !== undefined && currencyPrice.chaosValue > 0) {
      suggestions.push(buildSuggestion(trend, "item", currencyPrice.type, currencyPrice.chaosValue, durationDays));
    }
  }

  return suggestions.sort((a, b) => b.avgGrowthRatio - a.avgGrowthRatio);
}
