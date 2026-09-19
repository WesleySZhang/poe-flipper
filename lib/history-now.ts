/**
 * Reads a finished league's stored daily prices and presents them the way the live poe.ninja feed does:
 * "price now" plus a 7-day sparkline ending at "now". Lets the same feature code (lib/prediction-features.ts)
 * run on a replayed day of a past league (the Mirage simulator) and on training rows (scripts/export-training-
 * features.ts). Verified against the real API: poe.ninja's sparkline equals this league-history window
 * point-for-point except the last point, which is the live price (see ml/README.md).
 *
 * Deliberately CAUSAL: "now" and every sparkline point use only that day or earlier days (a missing day
 * falls back to the nearest EARLIER day within the tolerance, never a later one), so a replayed prediction
 * cannot see the future it is being scored against.
 */
import { getDb } from "./db";
import { itemPriceKey } from "./poe-ninja";
import { SPARK_POINTS } from "./prediction-features";

const CAUSAL_TOLERANCE_DAYS = 3;

export interface DailySeries {
  /** Chaos value by day offset (NaN = no price that day). Index = day_offset. */
  values: Float64Array;
  type?: string;
}

export interface LeagueDailyMatrix {
  league: string;
  maxDay: number;
  currency: Map<string, DailySeries>;
  /** Keyed by itemPriceKey(name, variant). */
  items: Map<string, DailySeries>;
  /** Chaos per Divine by day offset. */
  divineRate: Float64Array;
}

/** All prices for one league between minDay and maxDay (inclusive). */
export async function loadLeagueDailyMatrix(league: string, minDay: number, maxDay: number): Promise<LeagueDailyMatrix> {
  const db = await getDb();
  const params = { league, minDay: Math.max(0, minDay), maxDay };
  const [cur, itm, div] = await Promise.all([
    db.runAndReadAll(
      "SELECT name, day_offset, value FROM currency_history_dayed WHERE league = $league AND day_offset BETWEEN $minDay AND $maxDay",
      params
    ),
    db.runAndReadAll(
      "SELECT name, variant, type, day_offset, value FROM item_history_dayed WHERE league = $league AND day_offset BETWEEN $minDay AND $maxDay",
      params
    ),
    db.runAndReadAll(
      "SELECT day_offset, chaos_per_divine FROM divine_rate_dayed WHERE league = $league AND day_offset BETWEEN $minDay AND $maxDay",
      params
    ),
  ]);
  const size = maxDay + 1;
  const series = (map: Map<string, DailySeries>, key: string, type?: string) => {
    let s = map.get(key);
    if (!s) {
      s = { values: new Float64Array(size).fill(NaN), type };
      map.set(key, s);
    }
    return s;
  };
  const currency = new Map<string, DailySeries>();
  for (const [name, day, value] of cur.getRows()) series(currency, String(name))!.values[Number(day)] = Number(value);
  const items = new Map<string, DailySeries>();
  for (const [name, variant, type, day, value] of itm.getRows()) {
    series(items, itemPriceKey(String(name), variant ? String(variant) : undefined), type ? String(type) : undefined)!.values[Number(day)] =
      Number(value);
  }
  const divineRate = new Float64Array(size).fill(NaN);
  for (const [day, rate] of div.getRows()) divineRate[Number(day)] = Number(rate);
  return { league, maxDay, currency, items, divineRate };
}

/** Value on `day`, else the nearest earlier day within the tolerance, else NaN. Never looks forward. */
export function valueAtOrBefore(values: Float64Array, day: number, tolerance = CAUSAL_TOLERANCE_DAYS): number {
  for (let d = day; d >= Math.max(0, day - tolerance); d--) {
    const v = values[d];
    if (Number.isFinite(v) && v > 0) return v;
  }
  return NaN;
}

/** Nearest price within +-tolerance of `day` (ties -> earlier day), matching growth-ratios.ts's actual-value lookup. */
export function valueNearest(values: Float64Array, day: number, tolerance = CAUSAL_TOLERANCE_DAYS): number {
  for (let dist = 0; dist <= tolerance; dist++) {
    for (const d of dist === 0 ? [day] : [day - dist, day + dist]) {
      if (d < 0 || d >= values.length) continue;
      const v = values[d];
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return NaN;
}

/**
 * The 7-day sparkline poe.ninja would have shown on `day`: percent change of each day's price vs the
 * price 6 days earlier (the first point), oldest first, null where that day had no price.
 * Undefined when there is no price to anchor to.
 */
export function historySparkline(values: Float64Array, day: number): Array<number | null> | undefined {
  const pts: number[] = [];
  for (let i = SPARK_POINTS - 1; i >= 0; i--) {
    const d = day - i;
    pts.push(d < 0 ? NaN : valueAtOrBefore(values, d));
  }
  const base = pts.find((v) => Number.isFinite(v));
  if (base === undefined || !Number.isFinite(pts[SPARK_POINTS - 1])) return undefined;
  return pts.map((v) => (Number.isFinite(v) ? (v / base - 1) * 100 : null));
}

export interface HistoryNow {
  priceNow: number;
  spark?: Array<number | null>;
  type?: string;
}

/** Replays "now" = `day` of a stored league: price now and sparkline for every currency / item that has one. */
export function historyNowAtDay(matrix: LeagueDailyMatrix, day: number): {
  currency: Map<string, HistoryNow>;
  items: Map<string, HistoryNow>;
  divineRateNow?: number;
} {
  const build = (src: Map<string, DailySeries>) => {
    const out = new Map<string, HistoryNow>();
    for (const [key, s] of src) {
      const priceNow = valueAtOrBefore(s.values, day);
      if (Number.isFinite(priceNow)) out.set(key, { priceNow, spark: historySparkline(s.values, day), type: s.type });
    }
    return out;
  };
  const rate = valueAtOrBefore(matrix.divineRate, day);
  return { currency: build(matrix.currency), items: build(matrix.items), divineRateNow: Number.isFinite(rate) ? rate : undefined };
}
