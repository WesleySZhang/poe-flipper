import "server-only";
import { getDb } from "./db";

export interface PriceHistoryPoint {
  dayOffset: number;
  chaosValue: number;
  /** Undefined for a league/day with no Divine Orb rate on record (see divine_rate_dayed). */
  divineValue?: number;
}

export interface LeagueSeries {
  league: string;
  points: PriceHistoryPoint[];
}

/** Converts a matched row's chaos value to divines using the rate joined from its own day - same
 *  shape as growth-ratios.ts's divineValueFrom, reimplemented here rather than exported cross-module
 *  for one small reuse (this file is meant to stay a single-concern module, like price-unit.ts). */
function divineValueFrom(chaosValue: number, chaosPerDivine: unknown): number | undefined {
  const rate = Number(chaosPerDivine);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return chaosValue / rate;
}

function groupIntoSeries(rows: Record<string, unknown>[]): LeagueSeries[] {
  const byLeague = new Map<string, PriceHistoryPoint[]>();
  for (const row of rows) {
    const league = String(row.league);
    const points = byLeague.get(league) ?? [];
    const chaosValue = Number(row.value);
    points.push({
      dayOffset: Number(row.day_offset),
      chaosValue,
      divineValue: divineValueFrom(chaosValue, row.chaos_per_divine),
    });
    byLeague.set(league, points);
  }
  return Array.from(byLeague, ([league, points]) => ({ league, points }));
}

/**
 * Every recorded (league, day, price) point for one currency name, across every ingested past
 * league - powers the per-row price-history chart. Deliberately no nearest-day matching/tolerance
 * logic (unlike growth-ratios.ts) and no starting-value/confidence filtering - both dayed tables
 * already have ingest-time data-quality filtering baked in (see scripts/ingest-history.ts), and this
 * is a raw "show me everything" view, not a prediction input.
 */
export async function getCurrencyPriceHistory(name: string): Promise<LeagueSeries[]> {
  const db = await getDb();
  const reader = await db.runAndReadAll(
    `
    SELECT h.league, h.day_offset, h.value, dr.chaos_per_divine
    FROM currency_history_dayed h
    LEFT JOIN divine_rate_dayed dr ON dr.league = h.league AND dr.day_offset = h.day_offset
    WHERE h.name = $name
    ORDER BY h.league, h.day_offset
    `,
    { name }
  );
  return groupIntoSeries(reader.getRowObjects());
}

/** Same as getCurrencyPriceHistory but for items/uniques/gems, keyed by (name, variant). */
export async function getItemPriceHistory(name: string, variant?: string): Promise<LeagueSeries[]> {
  const db = await getDb();
  // Same conditional-clause pattern getNameDayCoverage uses (lib/growth-ratios.ts) - a bound NULL
  // parameter doesn't match "variant IS NULL" in SQL, so the clause has to branch instead.
  const variantClause = variant ? "AND h.variant = $variant" : "AND h.variant IS NULL";
  const reader = await db.runAndReadAll(
    `
    SELECT h.league, h.day_offset, h.value, dr.chaos_per_divine
    FROM item_history_dayed h
    LEFT JOIN divine_rate_dayed dr ON dr.league = h.league AND dr.day_offset = h.day_offset
    WHERE h.name = $name ${variantClause}
    ORDER BY h.league, h.day_offset
    `,
    { name, ...(variant ? { variant } : {}) }
  );
  return groupIntoSeries(reader.getRowObjects());
}
