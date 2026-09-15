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

// Wider than the default (used everywhere else, incl. the training-ratio matching above) purely for
// these single-league "actual value" lookups - there's no cross-league averaging risk here (unlike
// training, which needs a tight window so it doesn't blend genuinely different portions of each
// league's curve together), just "find the closest real price Mirage has". A common real gap: a
// niche/expensive item's price doesn't get published until several days after a fresh league opens
// (too few listings yet for poe.ninja to be confident), which silently dropped otherwise-fine items
// (e.g. Stranglegasp, Cooperation) from every early-game row entirely. Guarded below against the
// case both ends resolve to the identical day, which a plain widened window can't rule out on its own.
const ACTUAL_VALUE_TOLERANCE_DAYS = 10;

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
  /** Ratios with chaos debasement divided out - see GrowthRatioRow.avgRatioDivine. */
  predictedRatioDivine?: number;
  actualRatioDivine?: number;
  /** Leagues backing the divine-denominated figures - can be lower than leagueCount, so the
   *  confidence hover quotes the right denominator in divine mode. */
  leagueCountDivine: number;
  /** How reliably this has gained in the training leagues, 0-100 - see lib/confidence.ts. Scored
   *  from the same leagues the prediction came from, so it never peeks at Mirage's own outcome. */
  confidence: number;
  confidenceDivine?: number;
  /** Share of training leagues that gained, for the "N of M leagues" hover text. */
  upFraction: number;
  upFractionDivine?: number;
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
    getActualCurrencyValueAtDay(SIMULATED_LEAGUE, currentDay, ACTUAL_VALUE_TOLERANCE_DAYS),
    getActualCurrencyValueAtDay(SIMULATED_LEAGUE, targetDay, ACTUAL_VALUE_TOLERANCE_DAYS),
    getActualItemValueAtDay(SIMULATED_LEAGUE, currentDay, ACTUAL_VALUE_TOLERANCE_DAYS),
    getActualItemValueAtDay(SIMULATED_LEAGUE, targetDay, ACTUAL_VALUE_TOLERANCE_DAYS),
    // Mirage has ended, so poe.ninja no longer serves live prices for it to read a type bucket
    // from (that's the whole reason the historical DB exists). Its type-bucket taxonomy (Scarab,
    // Essence, Fossil, ...) is fixed and league-agnostic though, so the current league's live
    // buckets are a safe proxy purely for categorizing a currency name - not for its price.
    getAllCurrentCurrencyPrices(CURRENT_LEAGUE),
  ]);

  const rows: MirageSimulationRow[] = [];

  // Each actual value already carries its own day's divine conversion (see growth-ratios.ts), and
  // the predicted divine value comes from the divine-denominated ratio rather than converting a
  // chaos prediction - otherwise predicted and actual would be measured against Divine Orb rates
  // from different days, and the comparison would be skewed by however much divine inflated in
  // between (roughly 1.4x over a 14-day window early in Mirage).
  for (const trend of currencyTrends) {
    const actualNow = actualNowCurrency.get(trend.name);
    const actualFuture = actualFutureCurrency.get(trend.name);
    if (actualNow === undefined || actualFuture === undefined || actualNow.value <= 0) continue;
    // Both ends landed on the exact same day - the item's tracking window doesn't actually reach
    // both requested days, it just happens to have one point somewhere inside the widened search
    // radius above. Comparing that point to itself would show a false "0% actual change" instead of
    // the truth (not enough real separation to say anything) - skip rather than fabricate a result.
    if (actualNow.dayOffset === actualFuture.dayOffset) continue;
    rows.push({
      name: trend.name,
      category: "currency",
      filterCategory: currencyTypes.get(trend.name)?.type ?? "Currency",
      leagueCount: trend.leagueCount,
      actualNowChaos: actualNow.value,
      actualNowDivine: actualNow.valueDivine,
      predictedChaosValue: actualNow.value * trend.avgRatio,
      predictedDivineValue:
        actualNow.valueDivine !== undefined && trend.avgRatioDivine !== undefined
          ? actualNow.valueDivine * trend.avgRatioDivine
          : undefined,
      actualFutureChaos: actualFuture.value,
      actualFutureDivine: actualFuture.valueDivine,
      predictedRatio: trend.avgRatio,
      actualRatio: actualFuture.value / actualNow.value,
      predictedRatioDivine: trend.avgRatioDivine,
      leagueCountDivine: trend.leagueCountDivine,
      confidence: trend.confidence,
      confidenceDivine: trend.confidenceDivine,
      upFraction: trend.upFraction,
      upFractionDivine: trend.upFractionDivine,
      actualRatioDivine: divineRatio(actualNow.valueDivine, actualFuture.valueDivine),
    });
  }

  for (const trend of itemTrends) {
    const key = itemPriceKey(trend.name, trend.variant);
    const actualNow = actualNowItem.get(key);
    const actualFuture = actualFutureItem.get(key);
    if (actualNow === undefined || actualFuture === undefined || actualNow.value <= 0) continue;
    // See the currency loop's comment above - same collision guard.
    if (actualNow.dayOffset === actualFuture.dayOffset) continue;
    rows.push({
      name: formatItemDisplayName(trend.name, trend.variant),
      category: "item",
      filterCategory: actualNow.type || trend.name,
      leagueCount: trend.leagueCount,
      actualNowChaos: actualNow.value,
      actualNowDivine: actualNow.valueDivine,
      predictedChaosValue: actualNow.value * trend.avgRatio,
      predictedDivineValue:
        actualNow.valueDivine !== undefined && trend.avgRatioDivine !== undefined
          ? actualNow.valueDivine * trend.avgRatioDivine
          : undefined,
      actualFutureChaos: actualFuture.value,
      actualFutureDivine: actualFuture.valueDivine,
      predictedRatio: trend.avgRatio,
      actualRatio: actualFuture.value / actualNow.value,
      predictedRatioDivine: trend.avgRatioDivine,
      leagueCountDivine: trend.leagueCountDivine,
      confidence: trend.confidence,
      confidenceDivine: trend.confidenceDivine,
      upFraction: trend.upFraction,
      upFractionDivine: trend.upFractionDivine,
      actualRatioDivine: divineRatio(actualNow.valueDivine, actualFuture.valueDivine),
    });
  }

  return rows.sort((a, b) => b.predictedRatio - a.predictedRatio);
}

function divineRatio(now: number | undefined, future: number | undefined): number | undefined {
  if (now === undefined || future === undefined || now <= 0) return undefined;
  return future / now;
}
