/**
 * Snapshots TODAY's live prices (currency + items) and appends them to a growing, per-league CSV
 * pair - history/<League>/<League>.currency.csv and history/<League>/<League>.items.csv - built to
 * be a byte-for-byte drop-in match for poe.ninja's own downloadable historical export
 * (poe.ninja/poe1/data), the exact format scripts/ingest-history.ts already reads. A scheduled
 * GitHub Actions workflow (.github/workflows/precompute-predictions.yml) runs this once a day
 * alongside the predictions job and publishes the result to this repo's "data" branch.
 *
 * WHY this exists: scripts/ingest-history.ts only ever has data for a league once it's over and
 * someone manually downloads poe.ninja's export - the currently active league has no daily history
 * at all today (see lib/price-history.ts's header). This closes that gap incrementally, one real day
 * at a time, so by the time a league ends there's already a full, ready-to-ingest export for it - no
 * different from what you'd have downloaded from poe.ninja directly, just built up automatically.
 *
 * UNLIKE predictions.json (see that file's own doc for why it's always a single, disposable
 * snapshot), this file is meant to GROW for the whole life of a league - every run downloads
 * yesterday's accumulated CSVs from the "data" branch, appends today's rows, and republishes the
 * combined (larger) file. Re-running on the same day replaces that day's rows rather than
 * duplicating them, so a manual re-trigger is always safe.
 *
 * Format notes (matched against scripts/ingest-history.ts's own column list and comments):
 *   - currency.csv: League;Date;Get;Pay;Value;Confidence - one row per evergreen currency/fragment,
 *     "Get" priced in one "Pay" ("Chaos Orb"). Chaos Orb itself is never a row (nothing is priced in
 *     itself), matching ingest-history.ts's own `WHERE pay = 'Chaos Orb' AND get != 'Chaos Orb'`.
 *   - items.csv: League;Date;Id;Type;Name;BaseType;Variant;Links;Value;Confidence - everything else,
 *     including the currency-overview types poe.ninja's OWN historical export files under "items"
 *     (Scarab, Essence, DivinationCard, ...), not under "currency" - only Currency/Fragment get the
 *     Get/Pay treatment. "Links" uses the exact "1-4 links"/"5 links"/"6 links" text
 *     lib/poe-ninja.ts's linksBucketLabel() already produces and scripts/ingest-history.ts already
 *     expects - confirmed by that file's own comment, not guessed.
 *   - "Confidence" is always written as "High": the live API this reads from (lib/poe-ninja.ts) has
 *     no per-row confidence signal at all (unlike poe.ninja's real historical export, which tags
 *     Low-confidence days poe.ninja itself wasn't sure about) - "High" is the closest honest label,
 *     consistent with how the rest of this app already treats a live poe.ninja price as simply "the"
 *     current price, no confidence discount applied anywhere else either. "Id" is a synthetic
 *     per-run counter - scripts/ingest-history.ts never reads it, it only exists to satisfy the
 *     column count/type poe.ninja's own export has.
 *
 * FILES ARE CHUNKED BY CALENDAR MONTH (<League>.items.YYYY-MM.csv, not one ever-growing
 * <League>.items.csv) - measured at ~1.7MB/day for items.csv alone (24.8k live-priced items), a full
 * league (~90-100 days) in one file would be ~150-170MB, past GitHub's 100MB-per-push limit around
 * day 52 of EVERY future league, not a rare edge case. One file per month tops out around 31 days x
 * ~1.7MB =~53MB, comfortably under that limit with real margin regardless of how long a league runs.
 * scripts/ingest-history.ts's glob pattern and its currency/items classification were both widened
 * (a small, backward-compatible change - see that file) to pick up every month's chunk for a league
 * and UNION them in, exactly like it already does for multiple files per league.
 *
 * NOT validated end-to-end against the real ingestion script (that would mean pointing it at a
 * synthetic single-day dataset under the same POE_DATA_DIR as your real historical data, risking a
 * confusing mix) - instead scripts/_check-price-history-format.ts parses this file's output with the
 * exact same DuckDB read_csv_auto() call scripts/ingest-history.ts uses, structurally (columns,
 * types, row counts), which is safe to run against a throwaway in-memory database.
 *
 * MISSED DAYS: before writing, it reads the last two weeks of files and rebuilds any day in the last
 * 6 with no rows (a missed or failed run) from each line's 7-point poe.ninja sparkline, anchored on
 * today's price (lib/spark-backfill.ts), tagged Confidence=Medium. A day older than the sparkline
 * can't be rebuilt; it's reported as a warning for a week after it drops out of reach. Checked
 * against real stored days (2026-09-27): stash items came back with a median error of 0.0%;
 * exchange-priced types (currency, scarabs, cards, ...) differed from the job's own readings by a
 * median ~8-17%, mostly because a thin market's single live reading jumps day to day while poe.ninja's
 * sparkline is its steadier daily value. (This replaced a one-time backfill script.)
 *
 * Run: npx tsx scripts/precompute-price-history.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  getAllCurrentCurrencyPrices,
  getItemOverview,
  correctedItemType,
  linksBucketLabel,
  ITEM_OVERVIEW_TYPES,
  sparkPointsFrom,
} from "../lib/poe-ninja";
import { installRawResponseCache } from "./raw-response-cache";
import { CURRENT_LEAGUE, CURRENT_LEAGUE_START_DATE } from "../lib/league-recency";
import { isoDaysAgo, LOST_LOOKBACK_DAYS, planBackfill, SPARK_WINDOW_DAYS, valueFromSpark } from "../lib/spark-backfill";

const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
const HISTORY_DIR = path.join(__dirname, "..", "history");
// Still checked even with monthly chunking (see the module doc above for the real measured growth
// rate that made chunking necessary in the first place) - a genuine safety net, not the primary fix,
// in case a month's chunk somehow grows faster than expected (e.g. a huge new item category).
const MAX_SAFE_FILE_BYTES = 90 * 1024 * 1024;

function repoRawUrl(filePath: string): string {
  const repo = process.env.PREDICTIONS_REPO ?? "WesleySZhang/poe-flipper";
  return `https://raw.githubusercontent.com/${repo}/data/history/${filePath}`;
}

async function fetchExisting(filePath: string): Promise<string | undefined> {
  try {
    const res = await fetch(repoRawUrl(filePath), { headers: { "User-Agent": USER_AGENT } });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

/** Minimal CSV field quoting - only needed if a name ever contains the delimiter or a quote (rare
 *  for PoE item/currency names, but cheap insurance; read_csv_auto handles standard CSV quoting). */
function csvField(value: string | number): string {
  const s = String(value);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Drops any existing rows for `date` from a CSV's body (keeping the header at index 0) - makes
 *  re-running this script on the same day idempotent instead of duplicating that day's rows. */
function dropExistingDay(csvText: string | undefined, dateColumnIndex: number, date: string): string[] {
  if (!csvText) return [];
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const [header, ...rows] = lines;
  const kept = rows.filter((row) => row.split(";")[dateColumnIndex] !== date);
  return [header, ...kept];
}

/** Every "YYYY-MM" month touched by the last `days` days up to today. */
function recentMonths(today: Date, days: number): string[] {
  return [...new Set(Array.from({ length: days + 1 }, (_, i) => isoDaysAgo(today, i).slice(0, 7)))].sort();
}

/** One of today's prices, able to write its row for today or for a rebuilt earlier day. */
interface SnapshotRow {
  kind: "currency" | "items";
  chaosValue: number;
  /** poe.ninja's 7-point sparkline for this line, for rebuilding missed days (see lib/spark-backfill.ts). */
  spark?: Array<number | null>;
  row: (date: string, value: number, confidence: "High" | "Medium") => string;
}

const HEADERS = {
  currency: "League;Date;Get;Pay;Value;Confidence",
  items: "League;Date;Id;Type;Name;BaseType;Variant;Links;Value;Confidence",
} as const;

/** Writes a GitHub Actions annotation when running there, a plain log line otherwise. */
function annotate(level: "notice" | "warning", message: string) {
  console.log(process.env.GITHUB_ACTIONS ? `::${level}::${message}` : `${level}: ${message}`);
}

async function main() {
  installRawResponseCache(); // share poe.ninja responses with the other daily-job scripts - see raw-response-cache.ts
  const now = new Date();
  const today = now.toISOString().slice(0, 10); // UTC calendar day, matching poe.ninja's own daily-snapshot convention
  fs.mkdirSync(path.join(HISTORY_DIR, CURRENT_LEAGUE), { recursive: true });

  const snapshot: SnapshotRow[] = [];
  let nextId = 1;

  // Currency-overview types (see CURRENCY_OVERVIEW_TYPES's own comment in lib/poe-ninja.ts): only
  // Currency/Fragment are poe.ninja's own "currency.csv" style (an exchange PAIR); every other type
  // in that same live bucket (Scarab, Essence, DivinationCard, ...) is filed under "items.csv" in
  // poe.ninja's own historical export, keyed by CurrencyPrice.type below.
  const currencyPrices = await getAllCurrentCurrencyPrices(CURRENT_LEAGUE);
  for (const [name, price] of currencyPrices) {
    if (name === "Chaos Orb" || !(price.chaosValue > 0)) continue;
    if (price.type === "Currency" || price.type === "Fragment") {
      snapshot.push({
        kind: "currency",
        chaosValue: price.chaosValue,
        spark: price.spark,
        row: (date, value, confidence) => [CURRENT_LEAGUE, date, name, "Chaos Orb", value, confidence].map(csvField).join(";"),
      });
    } else {
      snapshot.push({
        kind: "items",
        chaosValue: price.chaosValue,
        spark: price.spark,
        row: (date, value, confidence) =>
          [CURRENT_LEAGUE, date, nextId++, price.type, name, "", "", "", value, confidence].map(csvField).join(";"),
      });
    }
  }

  // Genuine equipment/gem types - the only ones with a real BaseType/Variant/Links to carry.
  for (const type of ITEM_OVERVIEW_TYPES) {
    const lines = await getItemOverview(CURRENT_LEAGUE, type);
    for (const line of lines) {
      if (!(line.chaosValue > 0)) continue;
      const links = typeof line.links === "number" ? linksBucketLabel(line.links) : "";
      const itemType = correctedItemType(type, line.baseType);
      snapshot.push({
        kind: "items",
        chaosValue: line.chaosValue,
        spark: sparkPointsFrom(line.sparkLine),
        row: (date, value, confidence) =>
          [CURRENT_LEAGUE, date, nextId++, itemType, line.name, line.baseType ?? "", line.variant?.trim() ?? "", links, value, confidence]
            .map(csvField)
            .join(";"),
      });
    }
  }

  const todayCounts = { currency: 0, items: 0 };
  for (const s of snapshot) todayCounts[s.kind]++;
  if (todayCounts.currency === 0 || todayCounts.items === 0) {
    throw new Error(`Suspiciously empty snapshot (${todayCounts.currency} currency rows, ${todayCounts.items} item rows) - refusing to publish.`);
  }

  // The last LOST_LOOKBACK_DAYS of files: enough to see every day the sparkline can still rebuild,
  // and the days that just became unrecoverable. Files are per calendar month, so one or two of each.
  const months = recentMonths(now, LOST_LOOKBACK_DAYS);
  for (const kind of ["currency", "items"] as const) {
    const fileFor = (month: string) => `${CURRENT_LEAGUE}/${CURRENT_LEAGUE}.${kind}.${month}.csv`;
    const existing = new Map<string, string | undefined>();
    for (const month of months) existing.set(month, await fetchExisting(fileFor(month)));

    const presentDates = new Set<string>();
    for (const text of existing.values()) {
      for (const line of (text ?? "").split(/\r?\n/).slice(1)) {
        const date = line.split(";")[1];
        if (date) presentDates.add(date);
      }
    }

    // New rows per month: today's snapshot, plus any missed day the sparkline still reaches.
    const newRows = new Map<string, string[]>();
    const add = (date: string, row: string) => {
      const month = date.slice(0, 7);
      const list = newRows.get(month);
      if (list) list.push(row);
      else newRows.set(month, [row]);
    };
    const rows = snapshot.filter((s) => s.kind === kind);
    for (const s of rows) add(today, s.row(today, s.chaosValue, "High"));

    const plan = planBackfill(presentDates, now, CURRENT_LEAGUE_START_DATE);
    for (const { date, daysAgo } of plan.recoverable) {
      let rebuilt = 0;
      for (const s of rows) {
        const value = s.spark ? valueFromSpark(s.spark, s.chaosValue, daysAgo) : undefined;
        if (value === undefined) continue;
        add(date, s.row(date, value, "Medium"));
        rebuilt++;
      }
      annotate("notice", `${kind}: ${date} was missing - rebuilt ${rebuilt} rows from poe.ninja's sparkline (Confidence=Medium).`);
    }
    if (plan.unrecoverable.length > 0) {
      annotate(
        "warning",
        `${kind}: no rows for ${plan.unrecoverable.join(", ")} - older than the ${SPARK_WINDOW_DAYS}-day sparkline, so these days can't be rebuilt.`
      );
    }

    for (const [month, rowsForMonth] of newRows) {
      // Today's rows replace any earlier run's for today, so re-running on the same day is safe.
      const lines = dropExistingDay(existing.get(month), 1, today);
      const final = (lines.length > 0 ? lines : [HEADERS[kind]]).concat(rowsForMonth).join("\n") + "\n";
      const out = path.join(HISTORY_DIR, fileFor(month));
      fs.writeFileSync(out, final);
      const { size } = fs.statSync(out);
      console.log(`${fileFor(month)}: ${(size / 1024 / 1024).toFixed(2)} MB (+${rowsForMonth.length} rows)`);
      if (size > MAX_SAFE_FILE_BYTES) {
        throw new Error(`${out} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_SAFE_FILE_BYTES / 1024 / 1024} MB safety threshold - GitHub rejects a push over 100MB without Git LFS. This shouldn't happen given monthly chunking (see the module doc) unless something changed a lot (e.g. a huge new item category) - stop and address it (Git LFS, a finer chunk than a month, ...) before it publishes a broken day.`);
      }
    }
  }

  console.log(`Wrote ${todayCounts.currency} currency rows, ${todayCounts.items} item rows for ${CURRENT_LEAGUE} on ${today}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
