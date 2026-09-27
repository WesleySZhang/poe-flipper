import "server-only";
import { DISENCHANT_VALUES } from "./disenchant-values";
import { correctedItemType, getAllCurrentCurrencyPrices, getItemOverview, ITEM_OVERVIEW_TYPES, type ItemOverviewLine } from "./poe-ninja";
import { getActiveTypes } from "./price-snapshot";
import { sellerCountTier, UNIQUE_SELLER_COUNT_MEDIUM_MIN, type LiquidityTier } from "./liquidity";

/**
 * Uniques ranked by Thaumaturgic Dust per chaos for Kingsmarch disenchanting: each unique's base
 * dust value (lib/disenchant-values.ts, from poedb) against what it costs on poe.ninja right now.
 * The value is per unique, not per variant or link count, so each unique gets one row: its
 * cheapest poe.ninja line, preferring lines with at least UNIQUE_SELLER_COUNT_MEDIUM_MIN sellers so
 * a lone lowball listing doesn't stand in for the real price. The page scales `dustValue` by item
 * level (lib/dust.ts) - poe.ninja prices don't say what item level a listing is.
 *
 * Foulborn (mutated) uniques are left out: whether they give their base unique's dust is unchecked.
 */
export interface DustValueRow {
  /** The unique's name - also the key into DISENCHANT_VALUES and the detail page's historyName. */
  name: string;
  /** The chosen poe.ninja line's variant, links folded in the same way as elsewhere in the app
   *  (see effectiveVariant in lib/poe-ninja.ts) - so the detail page link resolves. */
  variant?: string;
  /** poe.ninja category bucket, e.g. UniqueArmour. */
  type: string;
  chaosValue: number;
  /** chaosValue at poe.ninja's Divine Orb price - a conversion; uniques trade in either. */
  divineValue?: number;
  sellerCount?: number;
  /** Base dust value - dust at item level 84 is this × 2000 (lib/dust.ts). */
  dustValue: number;
  confidence: LiquidityTier;
}

const FOULBORN_PREFIX = "Foulborn ";
const UNIQUE_TYPES = ITEM_OVERVIEW_TYPES.filter((t) => t.startsWith("Unique"));

// Same variant/links folding as lib/poe-ninja.ts's (unexported) effectiveVariant, so the detail
// page's name::variant key matches the one getAllCurrentItemPrices builds.
function lineVariant(line: ItemOverviewLine): string | undefined {
  const variant = line.variant?.trim() || undefined;
  const links = typeof line.links === "number" ? (line.links >= 6 ? "6 links" : line.links === 5 ? "5 links" : "1-4 links") : undefined;
  if (variant && links) return `${variant}, ${links}`;
  return variant ?? links;
}

/** The cheapest line with enough sellers to trust, or the cheapest line when none has. */
function pickLine(lines: ItemOverviewLine[]): ItemOverviewLine {
  const trusted = lines.filter((l) => (l.count ?? 0) >= UNIQUE_SELLER_COUNT_MEDIUM_MIN);
  const pool = trusted.length > 0 ? trusted : lines;
  return pool.reduce((best, l) => (l.chaosValue < best.chaosValue ? l : best));
}

// Same short-lived cache + in-flight coalescing as lib/divination-flips.ts.
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, { promise: Promise<DustValueRow[]>; expiresAt: number }>();

export async function getDustValues(league: string): Promise<DustValueRow[]> {
  const cached = cache.get(league);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = computeDustValues(league);
  cache.set(league, { promise, expiresAt: Date.now() + CACHE_TTL_MS });
  promise.catch(() => cache.delete(league));
  return promise;
}

async function computeDustValues(league: string): Promise<DustValueRow[]> {
  const activeTypes = await getActiveTypes(league);
  // No snapshot yet = request every unique type.
  const types = activeTypes.item ? UNIQUE_TYPES.filter((t) => activeTypes.item?.includes(t)) : UNIQUE_TYPES;
  const [overviews, currencyPrices] = await Promise.all([
    Promise.all(types.map((type) => getItemOverview(league, type))),
    getAllCurrentCurrencyPrices(league, activeTypes.currency),
  ]);
  const divineRate = currencyPrices.get("Divine Orb")?.chaosValue;

  const byName = new Map<string, { type: string; lines: ItemOverviewLine[] }>();
  overviews.forEach((lines, i) => {
    for (const line of lines) {
      if (line.name.startsWith(FOULBORN_PREFIX) || DISENCHANT_VALUES[line.name] === undefined || !(line.chaosValue > 0)) continue;
      const entry = byName.get(line.name) ?? { type: correctedItemType(types[i], line.baseType), lines: [] };
      entry.lines.push(line);
      byName.set(line.name, entry);
    }
  });

  const rows: DustValueRow[] = [];
  for (const [name, { type, lines }] of byName) {
    const line = pickLine(lines);
    rows.push({
      name,
      variant: lineVariant(line),
      type,
      chaosValue: line.chaosValue,
      divineValue: divineRate ? line.chaosValue / divineRate : undefined,
      sellerCount: line.count,
      dustValue: DISENCHANT_VALUES[name],
      confidence: sellerCountTier(line.count),
    });
  }
  return rows.sort((a, b) => b.dustValue / b.chaosValue - a.dustValue / a.chaosValue);
}
