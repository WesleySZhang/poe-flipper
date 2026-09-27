import type { FlipSuggestion } from "./flip-suggestions";
import type { PredictorMode } from "./prediction-model";

/**
 * Shared, environment-agnostic pieces of the precomputed-predictions format - deliberately its own
 * file, with NO "server-only" import, unlike lib/flip-suggestions.ts and
 * lib/precomputed-predictions.ts. Both of those are tagged server-only (they touch the DB / do a
 * server-side fetch), which makes them unimportable from a "use client" component even for a single
 * pure function - Next.js's server-only guard throws the moment such a module is reachable from a
 * client bundle at all. This file exists so components/flip-suggestions-panel.tsx can reconstruct
 * FlipSuggestion rows itself, client-side, from the SAME full precomputed file the server already
 * fetches - see that component for why (dragging the "Days ahead" slider needs to update the table
 * with zero network round-trips, not just an instant local preview number).
 */

/**
 * One item's stored fields - column-per-field, one entry per duration in the file's top-level
 * `durations` list (see scripts/precompute-predictions.ts's module doc for why this is columnar
 * rather than a duplicated FlipSuggestion[] per duration: the naive version was 225MB).
 */
export interface PrecomputedItem {
  name: string;
  historyName: string;
  variant?: string;
  category: "currency" | "item";
  filterCategory: string;
  faustusTradeable: boolean;
  predictor: PredictorMode;
  currentChaosValue: number;
  currentDivineValue: number | null;
  r: (number | null)[];
  rd: (number | null)[];
  lc: (number | null)[];
  lcd: (number | null)[];
  cf: (number | null)[];
  cfd: (number | null)[];
  uf: (number | null)[];
  ufd: (number | null)[];
  br: (number | null)[];
  brd: (number | null)[];
  fs: (number | null)[];
  /** Per horizon: 0/absent = real model row, 1 = interpolated, 2 = extended - see lib/horizon-fill.ts. */
  e?: (0 | 1 | 2)[];
}

export interface PrecomputedPredictions {
  league: string;
  currentDay: number;
  generatedAt: string;
  durations: number[];
  items: PrecomputedItem[];
}

export function isPrecomputedPredictions(value: unknown): value is PrecomputedPredictions {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.league === "string" &&
    typeof v.currentDay === "number" &&
    Array.isArray(v.durations) &&
    Array.isArray(v.items)
  );
}

/** How many days old a file may be and still be used (see alignPrecomputedToDay). GitHub's scheduled
 *  runs start hours after their 00:10 UTC cron, so every day the file is a day old from 00:00 UTC
 *  until the run lands; 2 also covers one fully missed run. */
export const MAX_PRECOMPUTED_LAG_DAYS = 2;

/**
 * Re-expresses a file computed `lag` days before `currentDay` in today's terms: the file's horizon h
 * targets league day (file.currentDay + h), which is today + (h - lag), so it becomes today's
 * duration h - lag. Horizons at or before today are dropped (a lag-day-old file covers durations
 * 1..30-lag); every per-horizon array is sliced to stay index-aligned with `durations`. Prices and
 * ratios are the file's own, untouched - the price snapshot the app shows is from the same run, so
 * nothing gets staler than it already was. Undefined when the file is from a later day or too old.
 */
export function alignPrecomputedToDay(
  data: PrecomputedPredictions,
  currentDay: number
): PrecomputedPredictions | undefined {
  const lag = currentDay - data.currentDay;
  if (lag === 0) return data;
  if (lag < 0 || lag > MAX_PRECOMPUTED_LAG_DAYS) return undefined;

  const keep: number[] = [];
  data.durations.forEach((h, i) => {
    if (h > lag) keep.push(i);
  });
  const pick = <T>(arr: T[]): T[] => keep.map((i) => arr[i]);
  return {
    ...data,
    currentDay,
    durations: pick(data.durations).map((h) => h - lag),
    items: data.items.map((it) => ({
      ...it,
      r: pick(it.r),
      rd: pick(it.rd),
      lc: pick(it.lc),
      lcd: pick(it.lcd),
      cf: pick(it.cf),
      cfd: pick(it.cfd),
      uf: pick(it.uf),
      ufd: pick(it.ufd),
      br: pick(it.br),
      brd: pick(it.brd),
      fs: pick(it.fs),
      ...(it.e ? { e: pick(it.e) } : {}),
    })),
  };
}

/**
 * The English explanation shown per row - its own pure function (rather than inlined in
 * lib/flip-suggestions.ts's buildSuggestion) so a precomputed row - server-side or, now,
 * client-side - can reconstruct the identical text from the handful of numbers it actually stores,
 * instead of needing to store this whole sentence per item per horizon (see
 * scripts/precompute-predictions.ts's module doc for why that mattered).
 */
export function buildFlipRationale(
  mode: PredictorMode,
  avgGrowthRatio: number,
  baselineGrowthRatio: number,
  leagueCount: number,
  durationDays: number
): string {
  const pctChange = Math.round((avgGrowthRatio - 1) * 100);
  const basePct = Math.round((baselineGrowthRatio - 1) * 100);
  const direction = pctChange >= 0 ? "risen" : "fallen";
  return mode === "baseline"
    ? `Historically has ${direction} ${Math.abs(pctChange)}% over the next ${durationDays} days from this point in the league, averaged over ${leagueCount} past leagues.`
    : `Model expects ${pctChange >= 0 ? "+" : "-"}${Math.abs(pctChange)}% over the next ${durationDays} days. Past leagues averaged ${basePct >= 0 ? "+" : "-"}${Math.abs(basePct)}% from this point (${leagueCount} leagues); the forecast adjusts that for how today's price compares with those leagues' and for the last 7 days' trend.`;
}

/** Rebuilds one FlipSuggestion from an item's stored columns at duration index `i` - the inverse of
 *  scripts/precompute-predictions.ts's accumulation. Returns undefined if this item has no usable
 *  row at that exact horizon (a null slot - the item wasn't priceable/trend-matched there). */
export function reconstructFlipSuggestion(item: PrecomputedItem, i: number, durationDays: number): FlipSuggestion | undefined {
  const avgGrowthRatio = item.r[i];
  const leagueCount = item.lc[i];
  const baselineGrowthRatio = item.br[i];
  if (avgGrowthRatio === null || leagueCount === null || baselineGrowthRatio === null) return undefined;

  const avgGrowthRatioDivine = item.rd[i] ?? undefined;
  const currentDivineValue = item.currentDivineValue ?? undefined;
  return {
    name: item.name,
    historyName: item.historyName,
    variant: item.variant,
    category: item.category,
    filterCategory: item.filterCategory,
    faustusTradeable: item.faustusTradeable,
    currentChaosValue: item.currentChaosValue,
    currentDivineValue,
    predictedChaosValue: item.currentChaosValue * avgGrowthRatio,
    predictedDivineValue: currentDivineValue !== undefined && avgGrowthRatioDivine !== undefined ? currentDivineValue * avgGrowthRatioDivine : undefined,
    avgGrowthRatio,
    avgGrowthRatioDivine,
    leagueCount,
    leagueCountDivine: item.lcd[i] ?? leagueCount,
    confidence: item.cf[i] ?? 0,
    confidenceDivine: item.cfd[i] ?? undefined,
    upFraction: item.uf[i] ?? 0,
    upFractionDivine: item.ufd[i] ?? undefined,
    rationale: buildFlipRationale(item.predictor, avgGrowthRatio, baselineGrowthRatio, leagueCount, durationDays),
    baselineGrowthRatio,
    baselineGrowthRatioDivine: item.brd[i] ?? undefined,
    predictor: item.predictor,
    forecastSpread: item.fs[i] ?? undefined,
    estimate: item.e?.[i] === 1 ? "interpolated" : item.e?.[i] === 2 ? "extended" : undefined,
  };
}

/** Every item's FlipSuggestion at one duration, straight from an already-fetched precomputed file -
 *  undefined if `data` is missing/stale or doesn't cover `durationDays` at all, so the caller can
 *  tell "nothing to show yet" apart from "genuinely zero rows" (an empty array is a real answer:
 *  every item happened to be unpriceable at this exact horizon, vanishingly unlikely but not the same
 *  as "we don't have this duration"). Sorted the same way every other suggestions list in this app is
 *  (by growth ratio descending) so a caller that skips its own re-sort still sees a sane default.
 */
export function reconstructAllFlipSuggestions(
  data: PrecomputedPredictions | null | undefined,
  durationDays: number
): FlipSuggestion[] | undefined {
  if (!data) return undefined;
  const i = data.durations.indexOf(durationDays);
  if (i === -1) return undefined;

  const suggestions: FlipSuggestion[] = [];
  for (const item of data.items) {
    const s = reconstructFlipSuggestion(item, i, durationDays);
    if (s) suggestions.push(s);
  }
  return suggestions.sort((a, b) => b.avgGrowthRatio - a.avgGrowthRatio);
}
