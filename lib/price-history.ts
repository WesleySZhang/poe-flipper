import "server-only";
import { getDb } from "./db";
import { getCurrentLeagueCurrencyHistory, getCurrentLeagueItemHistory } from "./current-league-history";
import { CURRENT_LEAGUE } from "./league-recency";

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

/** Appends the current league's own (live-collected, not yet ingested) series onto the DB-backed
 *  past-league series - see lib/current-league-history.ts for where it comes from. Filters out any
 *  same-named DB entry first, purely as a safety net for the edge case right at a league boundary
 *  (CURRENT_LEAGUE gets updated by hand once a league ends and is later ingested - there's no real
 *  window where both sources would legitimately have the same league, but two lines for one league
 *  would be a confusing enough bug to guard against anyway). `live` is undefined whenever nothing's
 *  been collected yet (see that function's own doc) - nothing to append in that case. */
function appendCurrentLeagueSeries(dbSeries: LeagueSeries[], live: LeagueSeries | undefined): LeagueSeries[] {
  const series = dbSeries.filter((s) => s.league !== CURRENT_LEAGUE);
  if (live) series.push(live);
  return series;
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
 *
 * Falls back to `item_history_dayed` when `name` has no rows under `currency_history_dayed` at
 * all - see lib/flip-suggestions.ts's own comment on the same migration for the full story:
 * Scarabs/Essences/Fossils/Oils/Omens/Resonators/Tattoos/DeliriumOrbs/DivinationCards were ingested
 * as "item" category (matching poe.ninja's OLD live-price endpoint for them at ingest time) but
 * poe.ninja has since moved their LIVE prices onto the currency endpoint - so every caller that
 * treats one of these (a divination card, say) as category "currency" today, matching its current
 * live price, would otherwise find zero rows for its actual historical data, which lives under
 * "item" instead. Without this fallback, a card's dedicated page/table row showed "no historical
 * price data" even though the exact same name had a real, populated chart under category "item".
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
  const rows = reader.getRowObjects();
  if (rows.length === 0) {
    // These migrated types never have a variant (see the doc above) - variant IS NULL, same as
    // getItemPriceHistory's own no-variant branch.
    const itemReader = await db.runAndReadAll(
      `
      SELECT h.league, h.day_offset, h.value, dr.chaos_per_divine
      FROM item_history_dayed h
      LEFT JOIN divine_rate_dayed dr ON dr.league = h.league AND dr.day_offset = h.day_offset
      WHERE h.name = $name AND h.variant IS NULL
      ORDER BY h.league, h.day_offset
      `,
      { name }
    );
    const itemRows = itemReader.getRowObjects();
    if (itemRows.length > 0) {
      return appendCurrentLeagueSeries(groupIntoSeries(itemRows), await getCurrentLeagueCurrencyHistory(name));
    }
  }
  return appendCurrentLeagueSeries(groupIntoSeries(rows), await getCurrentLeagueCurrencyHistory(name));
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
  return appendCurrentLeagueSeries(
    groupIntoSeries(reader.getRowObjects()),
    await getCurrentLeagueItemHistory(name, variant)
  );
}
