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
  /** Undefined only if Divine Orb itself has no price for this day (shouldn't normally happen). */
  actualNowDivine?: number;
  predictedChaosValue: number;
  predictedDivineValue?: number;
  actualFutureChaos: number;
  actualFutureDivine?: number;
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

  // Same reasoning as the live flip-suggestions side (see lib/flip-suggestions.ts): a chaos price
  // alone conflates an item's own value with Divine Orb's exchange rate, which inflates a lot over
  // a league. Here "now" and "future" are two different historical days, so each needs its own
  // day-specific rate rather than a single current one.
  const nowDivineRate = actualNowCurrency.get("Divine Orb");
  const futureDivineRate = actualFutureCurrency.get("Divine Orb");

  const rows: MirageSimulationRow[] = [];

  for (const trend of currencyTrends) {
    const actualNow = actualNowCurrency.get(trend.name);
    const actualFuture = actualFutureCurrency.get(trend.name);
    if (actualNow === undefined || actualFuture === undefined || actualNow <= 0) continue;
    const predictedChaosValue = actualNow * trend.avgRatio;
    rows.push({
      name: trend.name,
      category: "currency",
      filterCategory: currencyTypes.get(trend.name)?.type ?? "Currency",
      leagueCount: trend.leagueCount,
      actualNowChaos: actualNow,
      actualNowDivine: nowDivineRate ? actualNow / nowDivineRate : undefined,
      predictedChaosValue,
      predictedDivineValue: nowDivineRate ? predictedChaosValue / nowDivineRate : undefined,
      actualFutureChaos: actualFuture,
      actualFutureDivine: futureDivineRate ? actualFuture / futureDivineRate : undefined,
      predictedRatio: trend.avgRatio,
      actualRatio: actualFuture / actualNow,
    });
  }

  for (const trend of itemTrends) {
    const key = itemPriceKey(trend.name, trend.variant);
    const actualNow = actualNowItem.get(key);
    const actualFuture = actualFutureItem.get(key);
    if (actualNow === undefined || actualFuture === undefined || actualNow.value <= 0) continue;
    const predictedChaosValue = actualNow.value * trend.avgRatio;
    rows.push({
      name: formatItemDisplayName(trend.name, trend.variant),
      category: "item",
      filterCategory: actualNow.type || trend.name,
      leagueCount: trend.leagueCount,
      actualNowChaos: actualNow.value,
      actualNowDivine: nowDivineRate ? actualNow.value / nowDivineRate : undefined,
      predictedChaosValue,
      predictedDivineValue: nowDivineRate ? predictedChaosValue / nowDivineRate : undefined,
      actualFutureChaos: actualFuture.value,
      actualFutureDivine: futureDivineRate ? actualFuture.value / futureDivineRate : undefined,
      predictedRatio: trend.avgRatio,
      actualRatio: actualFuture.value / actualNow.value,
    });
  }

  return rows.sort((a, b) => b.predictedRatio - a.predictedRatio);
}
