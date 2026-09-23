import "server-only";
import { getAllCurrentCurrencyPrices, getAllCurrentItemPrices, itemPriceKey, formatItemDisplayName } from "./poe-ninja";
import { getCurrencyGrowthRatios, getItemGrowthRatios, type GrowthRatioRow } from "./growth-ratios";
import { getFaustusPrices, isFaustusTradeable } from "./faustus";
import { currentPredictorMode, predictGrowth, type GrowthPrediction, type PredictorMode } from "./prediction-model";
import type { PredictionInput } from "./prediction-features";
import { buildFlipRationale } from "./predicted-suggestion";

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

// The learned model's trained/validated range (see ml/README.md) - also what
// scripts/precompute-predictions.ts precomputes daily and components/flip-suggestions-panel.tsx caps
// its slider drag range to. Shared here (rather than each of those three redeclaring "1-30"
// independently) so the precomputed file, the live per-item "predicted curve" fallback below, and the
// UI's own notion of "past this point it's live, not precomputed" can never quietly drift apart.
export const CURVE_MIN_DURATION_DAYS = 1;
export const CURVE_MAX_DURATION_DAYS = 30;

function isThinMarketOutlier(ratio: number, sellerCount: number | undefined): boolean {
  if (sellerCount === undefined || sellerCount >= MIN_ITEM_SELLER_COUNT_FOR_EXTREME_RATIO) return false;
  return ratio > EXTREME_RATIO_HIGH || ratio < EXTREME_RATIO_LOW;
}

export interface FlipSuggestion {
  name: string;
  /** Raw, pre-display-formatting name - what lib/price-history.ts's queries key on. Equal to `name`
   *  for currency (formatItemDisplayName is a no-op there); differs for items with a variant suffix
   *  like "(21/23c)" appended to `name` for display. */
  historyName: string;
  /** Undefined for currency - present for an item/gem/unique with a distinct quality/level/links
   *  variant, alongside historyName, so a caller can query its exact price history. */
  variant?: string;
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
  /** The original production estimate (plain average of past leagues' growth) that avgGrowthRatio replaces when a
   *  learned predictor is active - kept so the UI/tests can show or compare both. Equal to avgGrowthRatio when
   *  predictor is "baseline". */
  baselineGrowthRatio: number;
  baselineGrowthRatioDivine?: number;
  /** Which model produced avgGrowthRatio - see lib/prediction-model.ts. */
  predictor: PredictorMode;
  /** How wide the model's own forecast range is for THIS row, as a ratio-space multiple (>= 1) - see
   *  GrowthPrediction.forecastSpread. A different signal from `confidence`: that says how consistently this
   *  item has gained historically; this says how much the model itself trusts today's specific number.
   *  Undefined outside xgb mode, in divine-only rows, or when the model file has no quantile heads. */
  forecastSpread?: number;
}

/** A live-priced item ready to be scored, before the (cross-sectional) predictor runs over the whole set. */
interface Candidate {
  trend: GrowthRatioRow;
  category: "currency" | "item";
  filterCategory: string;
  chaosValue: number;
  spark?: Array<number | null>;
}

function buildSuggestion(
  baseTrend: GrowthRatioRow,
  prediction: GrowthPrediction,
  mode: PredictorMode,
  category: "currency" | "item",
  filterCategory: string,
  currentChaosValue: number,
  durationDays: number,
  divineRate: number | undefined
): FlipSuggestion {
  // The learned predictor replaces the growth ratios (chaos and divine); everything else about the row - league
  // count, confidence, "N of M leagues gained" - still describes the past leagues it was learned from.
  const trend = { ...baseTrend, avgRatio: prediction.ratio, avgRatioDivine: prediction.ratioDivine };
  const displayName = formatItemDisplayName(trend.name, trend.variant);
  const currentDivineValue = divineRate ? currentChaosValue / divineRate : undefined;
  return {
    name: displayName,
    historyName: trend.name,
    variant: trend.variant,
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
    rationale: buildFlipRationale(mode, trend.avgRatio, baseTrend.avgRatio, trend.leagueCount, durationDays),
    baselineGrowthRatio: baseTrend.avgRatio,
    baselineGrowthRatioDivine: baseTrend.avgRatioDivine,
    predictor: mode,
    forecastSpread: prediction.forecastSpread,
  };
}

// Short-lived cache, keyed on every input this function's result actually depends on - this is the
// expensive live-fallback path (a full DB growth-ratio scan across every item plus the learned
// model, run cross-sectionally) that app/api/flip-suggestions/route.ts only reaches when the daily
// precomputed file is missing/stale, but the per-item detail page (components/item-detail-panel.tsx)
// hits it directly for its "predicted curve" fetch AND its own live-suggestions fallback on every
// mount, alongside sibling requests (divination-flips, item-detail) that also do their own heavy DB
// work. Without this, several of those concurrent, uncached, DB-heavy calls landing at once could
// serialize behind each other for tens of seconds - reported as "extreme lag navigating" even to
// unrelated pages, since a slow synchronous DB query blocks the whole single-threaded dev server, not
// just the one request that triggered it. TTL is short since this depends on live, moving prices.
const CACHE_TTL_MS = 60 * 1000;
interface CacheEntry {
  promise: Promise<FlipSuggestion[]>;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

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
  const key = `${league}:${currentDay}:${durationDays}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  // Cached as the in-flight PROMISE, not just its resolved value - concurrent callers within the
  // same tick (exactly what the item-detail page's simultaneous fetches produce) share this one
  // computation instead of each independently kicking off their own, which plain "cache the result
  // after it resolves" would still allow (every concurrent caller would see a cache miss before the
  // first one finishes). A rejected promise is removed immediately so a transient failure doesn't
  // poison the cache for the rest of its TTL.
  const promise = computeFlipSuggestions(league, currentDay, durationDays);
  cache.set(key, { promise, expiresAt: Date.now() + CACHE_TTL_MS });
  promise.catch(() => cache.delete(key));
  return promise;
}

async function computeFlipSuggestions(
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

  // Every item with a live price is collected first: the learned predictor's price-vs-history and momentum
  // ranks are cross-sectional (they compare each item with all the others), so all rows are scored together.
  const candidates: Candidate[] = [];

  for (const trend of currencyTrends) {
    const price = currencyPrices.get(trend.name);
    if (price !== undefined && price.chaosValue > 0) {
      candidates.push({ trend, category: "currency", filterCategory: price.type, chaosValue: price.chaosValue, spark: price.spark });
      continue;
    }
    // poe.ninja hasn't listed a live price for this currency at all yet (common for a brand-new or
    // low-volume item early in a league) - GGG's own Currency Exchange (Faustus) trade data covers a
    // small, evergreen subset of currencies (see lib/faustus.ts) and can fill this gap when it does.
    const faustusPrice = faustusPrices.get(trend.name);
    if (faustusPrice !== undefined && faustusPrice.chaosValue > 0) {
      candidates.push({ trend, category: "currency", filterCategory: "Currency", chaosValue: faustusPrice.chaosValue });
    }
  }

  for (const trend of itemTrends) {
    const itemPrice = itemPrices.get(itemPriceKey(trend.name, trend.variant));
    if (itemPrice !== undefined && itemPrice.chaosValue > 0) {
      // See isThinMarketOutlier above - skip rather than fall through to the currency-price
      // fallback below, which prices a completely different set of items (Scarabs/Essences/etc.)
      // and wouldn't legitimately apply to this same trend. Judged on the historical ratio (the thing that
      // was swung by a handful of sellers), not on the learned forecast.
      if (!isThinMarketOutlier(trend.avgRatio, itemPrice.sellerCount)) {
        candidates.push({ trend, category: "item", filterCategory: itemPrice.type, chaosValue: itemPrice.chaosValue, spark: itemPrice.spark });
      }
      continue;
    }
    // Scarabs/Essences/Fossils/Oils/Omens/Resonators/Tattoos/DeliriumOrbs/DivinationCards are
    // categorized as items in the ingested history (item_history.type) but poe.ninja has since moved
    // their live prices onto the currency endpoint (see CURRENCY_OVERVIEW_TYPES) - fall back to the
    // currency price map, keyed on name only since these never have a variant.
    const currencyPrice = !trend.variant ? currencyPrices.get(trend.name) : undefined;
    if (currencyPrice !== undefined && currencyPrice.chaosValue > 0) {
      candidates.push({ trend, category: "item", filterCategory: currencyPrice.type, chaosValue: currencyPrice.chaosValue, spark: currencyPrice.spark });
    }
  }

  const mode = currentPredictorMode();
  const inputs: PredictionInput[] = candidates.map((c, i) => ({
    key: String(i),
    kind: c.category,
    ratio: c.trend,
    priceNow: c.chaosValue,
    divineRateNow: divineRate,
    spark: c.spark,
  }));
  const predictions = predictGrowth(inputs, { currentDay, durationDays, universe: [...currencyTrends, ...itemTrends] }, mode);
  const suggestions = candidates.map((c, i) =>
    buildSuggestion(c.trend, predictions[i], mode, c.category, c.filterCategory, c.chaosValue, durationDays, divineRate)
  );

  return suggestions.sort((a, b) => b.avgGrowthRatio - a.avgGrowthRatio);
}

export interface PredictionCurvePoint {
  durationDays: number;
  predictedChaosValue: number | null;
  predictedDivineValue: number | null;
}

/**
 * One item's predicted price at every duration from CURVE_MIN_DURATION_DAYS to
 * CURVE_MAX_DURATION_DAYS - the live fallback for lib/precomputed-predictions.ts's
 * getPrecomputedPredictionCurve, used when today's precomputed file is missing or stale. Drawn on
 * the price history chart as a detailed day-by-day forecast line instead of a single straight
 * segment (see components/price-history-chart.tsx's predictedCurve prop).
 *
 * Deliberately reruns the full getFlipSuggestions() batch once per duration rather than a cheaper
 * single-item path - there isn't one (the model's features are cross-sectional, scored against every
 * other live-priced item at once), and this only ever runs on an explicit row expand, not on every
 * page load, so the cost is bounded to "one click, when the precomputed file happens to be stale" -
 * see scripts/precompute-predictions.ts's own module doc for the same 30-calls-is-fine reasoning.
 */
export async function getLiveFlipSuggestionCurve(
  league: string,
  currentDay: number,
  category: "currency" | "item",
  historyName: string,
  variant: string | undefined
): Promise<PredictionCurvePoint[]> {
  const durations: number[] = [];
  for (let d = CURVE_MIN_DURATION_DAYS; d <= CURVE_MAX_DURATION_DAYS; d++) durations.push(d);

  return Promise.all(
    durations.map(async (durationDays) => {
      const suggestions = await getFlipSuggestions(league, currentDay, durationDays);
      const match = suggestions.find(
        (s) => s.category === category && s.historyName === historyName && (s.variant ?? "") === (variant ?? "")
      );
      return {
        durationDays,
        predictedChaosValue: match?.predictedChaosValue ?? null,
        predictedDivineValue: match?.predictedDivineValue ?? null,
      };
    })
  );
}
