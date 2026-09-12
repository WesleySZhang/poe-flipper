import "server-only";
import {
  getCurrencyGrowthRatios,
  getItemGrowthRatios,
  getActualCurrencyValueAtDay,
  getActualItemValueAtDay,
} from "./growth-ratios";
import { itemPriceKey, getAllCurrentCurrencyPrices, formatItemDisplayName } from "./poe-ninja";
import { SIMULATED_LEAGUE } from "./mirage-league";
import { CURRENT_LEAGUE } from "./league-recency";

export interface MirageSimulationRow {
  name: string;
  category: "currency" | "item";
  /** What the category filter groups by: the item's or currency's poe.ninja type bucket (SkillGem, Scarab, Currency, ...). */
  filterCategory: string;
  leagueCount: number;
  actualNowChaos: number;
  predictedChaosValue: number;
  actualFutureChaos: number;
  predictedRatio: number;
  actualRatio: number;
}

/**
 * Re-runs the flip-suggestion model as if "now" were day `currentDay` of the already-finished
 * Mirage league, projecting `durationDays` ahead - then looks up what actually happened in Mirage
 * so the prediction can be checked against reality. Mirage is always excluded from the model's
 * training data, so this is a genuine out-of-sample check, not the model grading its own homework.
 * Returns every matching row (no top-N cap) - the UI paginates and category-filters client-side.
 */
export async function simulateMirageLeague(
  currentDay: number,
  durationDays: number
): Promise<MirageSimulationRow[]> {
  const targetDay = currentDay + durationDays;

  const [
    currencyTrends,
    itemTrends,
    actualNowCurrency,
    actualFutureCurrency,
    actualNowItem,
    actualFutureItem,
    currencyTypes,
  ] = await Promise.all([
    getCurrencyGrowthRatios({ currentDay, durationDays, excludeLeague: SIMULATED_LEAGUE }),
    getItemGrowthRatios({ currentDay, durationDays, excludeLeague: SIMULATED_LEAGUE }),
    getActualCurrencyValueAtDay(SIMULATED_LEAGUE, currentDay),
    getActualCurrencyValueAtDay(SIMULATED_LEAGUE, targetDay),
    getActualItemValueAtDay(SIMULATED_LEAGUE, currentDay),
    getActualItemValueAtDay(SIMULATED_LEAGUE, targetDay),
    // Mirage has ended, so poe.ninja no longer serves live prices for it to read a type bucket
    // from (that's the whole reason the historical DB exists). Its type-bucket taxonomy (Scarab,
    // Essence, Fossil, ...) is fixed and league-agnostic though, so the current league's live
    // buckets are a safe proxy purely for categorizing a currency name - not for its price.
    getAllCurrentCurrencyPrices(CURRENT_LEAGUE),
  ]);

  const rows: MirageSimulationRow[] = [];

  for (const trend of currencyTrends) {
    const actualNow = actualNowCurrency.get(trend.name);
    const actualFuture = actualFutureCurrency.get(trend.name);
    if (actualNow === undefined || actualFuture === undefined || actualNow <= 0) continue;
    rows.push({
      name: trend.name,
      category: "currency",
      filterCategory: currencyTypes.get(trend.name)?.type ?? "Currency",
      leagueCount: trend.leagueCount,
      actualNowChaos: actualNow,
      predictedChaosValue: actualNow * trend.avgRatio,
      actualFutureChaos: actualFuture,
      predictedRatio: trend.avgRatio,
      actualRatio: actualFuture / actualNow,
    });
  }

  for (const trend of itemTrends) {
    const key = itemPriceKey(trend.name, trend.variant);
    const actualNow = actualNowItem.get(key);
    const actualFuture = actualFutureItem.get(key);
    if (actualNow === undefined || actualFuture === undefined || actualNow.value <= 0) continue;
    rows.push({
      name: formatItemDisplayName(trend.name, trend.variant),
      category: "item",
      filterCategory: actualNow.type || trend.name,
      leagueCount: trend.leagueCount,
      actualNowChaos: actualNow.value,
      predictedChaosValue: actualNow.value * trend.avgRatio,
      actualFutureChaos: actualFuture.value,
      predictedRatio: trend.avgRatio,
      actualRatio: actualFuture.value / actualNow.value,
    });
  }

  return rows.sort((a, b) => b.predictedRatio - a.predictedRatio);
}
