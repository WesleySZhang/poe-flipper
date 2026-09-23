import "server-only";
import { CURRENT_LEAGUE, CURRENT_LEAGUE_START_DATE } from "./league-recency";
import { daysBetweenUtc } from "./league-day";
import { itemPriceKey } from "./poe-ninja";
import type { LeagueSeries, PriceHistoryPoint } from "./price-history";

/**
 * The CURRENTLY ACTIVE league's own price history, built from the raw daily CSV snapshots
 * scripts/precompute-price-history.ts has been collecting on the "data" branch since the day it was
 * added - not from db/history.duckdb, which only ever has FINISHED, manually-ingested leagues (see
 * that file's own module doc). This is what lets components/price-history-chart.tsx draw a real,
 * solid line for the current league up to today, instead of starting the chart with nothing but a
 * dashed forecast and no actual history behind it.
 *
 * Reads exactly the two raw file conventions scripts/precompute-price-history.ts writes and
 * scripts/ingest-history.ts will eventually ingest this same league from once it's over - see that
 * script's own module doc for the exact column layout. Deliberately mirrors the SAME
 * currency-vs-item split lib/price-history.ts's two DB-backed functions already use (one function
 * each, one raw file each) rather than trying to reclassify rows by "type" - a row's presence in
 * currency.csv vs items.csv is already the correct, existing signal for which of the two this app's
 * FlipSuggestion.category ends up as.
 *
 * Never throws - a missing/not-yet-collected file, a network error, or empty content all just
 * resolve to no data for that name, so the chart simply doesn't draw a current-league line (falls
 * back to exactly today's behavior, same "graceful when a secondary source is missing" pattern
 * predictions.json and the price-history CSVs themselves already follow).
 */

const DEFAULT_REPO = "WesleySZhang/poe-flipper";
const DATA_BRANCH = "data";
const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
// Same reasoning as lib/precomputed-predictions.ts's own cache - these files only change once a day.
// Short (not e.g. 20 minutes) specifically so that once the daily ingest job (see
// .github/workflows/precompute-predictions.yml) publishes a new day's row, an already-warm
// serverless instance picks it up quickly rather than serving the previous day's cached fetch for
// up to a further 20 minutes on top of however late the job itself ran.
const CACHE_TTL_MS = 2 * 60 * 1000;

function repoRawUrl(filePath: string): string {
  const repo = process.env.PREDICTIONS_REPO ?? DEFAULT_REPO;
  return `https://raw.githubusercontent.com/${repo}/${DATA_BRANCH}/history/${filePath}`;
}

/**
 * Minimal semicolon-delimited CSV line parser matching scripts/precompute-price-history.ts's own
 * csvField() quoting exactly (a field is wrapped in "..." with internal quotes doubled, but ONLY
 * when it contains a delimiter/quote/newline - most fields are plain, unquoted text). A bare
 * `.split(";")` would misparse a quoted field's own internal semicolons; this handles both cases.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    let field = "";
    if (line[i] === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += line[i++];
      }
    } else {
      while (i < line.length && line[i] !== ";") field += line[i++];
    }
    fields.push(field);
    if (line[i] === ";") {
      i++;
      continue;
    }
    break;
  }
  return fields;
}

/** Every calendar month from the league's launch through today, "YYYY-MM" - the exact chunk
 *  filenames scripts/precompute-price-history.ts writes (see that file for why it's chunked). A
 *  month with nothing collected yet (the future, or before this feature existed) just 404s below. */
function monthsSinceLeagueStart(): string[] {
  const start = new Date(CURRENT_LEAGUE_START_DATE);
  const now = new Date();
  const months: string[] = [];
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  while (year < now.getUTCFullYear() || (year === now.getUTCFullYear() && month <= now.getUTCMonth())) {
    months.push(`${year}-${String(month + 1).padStart(2, "0")}`);
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }
  return months;
}

async function fetchMonth(kind: "currency" | "items", month: string): Promise<string | undefined> {
  const path = `${CURRENT_LEAGUE}/${CURRENT_LEAGUE}.${kind}.${month}.csv`;
  try {
    const res = await fetch(repoRawUrl(path), { headers: { "User-Agent": USER_AGENT } });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

function toSeriesPoints(byDay: Map<number, number>, divinePerDay: Map<number, number>): PriceHistoryPoint[] {
  return Array.from(byDay, ([dayOffset, chaosValue]) => {
    const rate = divinePerDay.get(dayOffset);
    return { dayOffset, chaosValue, divineValue: rate && rate > 0 ? chaosValue / rate : undefined };
  }).sort((a, b) => a.dayOffset - b.dayOffset);
}

interface CurrencyCache {
  // Map<name, Map<dayOffset, chaosValue>> - the inner Map dedupes by day (keeping the last-seen
  // row for that day) rather than just pushing every row, as a safety net against a boundary date
  // somehow appearing in two month-chunks; the outer array flatten only happens on actual lookup.
  byName: Map<string, Map<number, number>>;
  divinePerDay: Map<number, number>;
}

let currencyCache: { data: CurrencyCache; expiresAt: number } | undefined;

async function loadCurrencyHistory(): Promise<CurrencyCache> {
  if (currencyCache && currencyCache.expiresAt > Date.now()) return currencyCache.data;

  const texts = await Promise.all(monthsSinceLeagueStart().map((m) => fetchMonth("currency", m)));
  const byName = new Map<string, Map<number, number>>();
  const divinePerDay = new Map<number, number>();
  const leagueStart = new Date(CURRENT_LEAGUE_START_DATE);

  for (const text of texts) {
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const [, date, get, pay, value] = parseCsvLine(lines[i]);
      // Same filter ingest-history.ts's own currency_daily view applies: "Get" priced in Chaos
      // Orb, Chaos Orb itself never a row (nothing is priced in itself).
      if (pay !== "Chaos Orb" || get === "Chaos Orb") continue;
      const dayOffset = daysBetweenUtc(leagueStart, new Date(date));
      const chaosValue = Number(value);
      if (!Number.isFinite(chaosValue)) continue;

      const points = byName.get(get) ?? new Map<number, number>();
      points.set(dayOffset, chaosValue);
      byName.set(get, points);

      if (get === "Divine Orb") divinePerDay.set(dayOffset, chaosValue);
    }
  }

  const data = { byName, divinePerDay };
  currencyCache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

interface ItemCache {
  byKey: Map<string, Map<number, number>>;
}

let itemCache: { data: ItemCache; expiresAt: number } | undefined;

async function loadItemHistory(): Promise<ItemCache> {
  if (itemCache && itemCache.expiresAt > Date.now()) return itemCache.data;

  const texts = await Promise.all(monthsSinceLeagueStart().map((m) => fetchMonth("items", m)));
  const byKey = new Map<string, Map<number, number>>();
  const leagueStart = new Date(CURRENT_LEAGUE_START_DATE);

  for (const text of texts) {
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      // League;Date;Id;Type;Name;BaseType;Variant;Links;Value;Confidence - Id/Type/BaseType/Links
      // aren't needed here (item_history_dayed itself is keyed on name+variant only, same as
      // lib/price-history.ts's getItemPriceHistory query).
      const [, date, , , name, , variant, , value] = parseCsvLine(lines[i]);
      const dayOffset = daysBetweenUtc(leagueStart, new Date(date));
      const chaosValue = Number(value);
      if (!Number.isFinite(chaosValue)) continue;

      const key = itemPriceKey(name, variant);
      const points = byKey.get(key) ?? new Map<number, number>();
      points.set(dayOffset, chaosValue);
      byKey.set(key, points);
    }
  }

  const data = { byKey };
  itemCache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

/** The current league's own history for one currency name - undefined if nothing's been collected
 *  for it yet (a brand-new currency this league, or the daily job hasn't run at all). */
export async function getCurrentLeagueCurrencyHistory(name: string): Promise<LeagueSeries | undefined> {
  const { byName, divinePerDay } = await loadCurrencyHistory();
  const byDay = byName.get(name);
  if (!byDay || byDay.size === 0) return undefined;
  return { league: CURRENT_LEAGUE, points: toSeriesPoints(byDay, divinePerDay) };
}

/** Same as getCurrentLeagueCurrencyHistory but for items/uniques/gems, keyed by (name, variant) -
 *  needs the currency file too (via loadCurrencyHistory, independently cached) purely for its
 *  Divine Orb rate, same reason lib/price-history.ts's getItemPriceHistory joins divine_rate_dayed. */
export async function getCurrentLeagueItemHistory(name: string, variant?: string): Promise<LeagueSeries | undefined> {
  const [{ byKey }, { divinePerDay }] = await Promise.all([loadItemHistory(), loadCurrencyHistory()]);
  const byDay = byKey.get(itemPriceKey(name, variant));
  if (!byDay || byDay.size === 0) return undefined;
  return { league: CURRENT_LEAGUE, points: toSeriesPoints(byDay, divinePerDay) };
}
