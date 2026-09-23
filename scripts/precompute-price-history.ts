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
 * Run: npx tsx scripts/precompute-price-history.ts
 */
import fs from "node:fs";
import path from "node:path";
import { getAllCurrentCurrencyPrices, getItemOverview, correctedItemType, linksBucketLabel, ITEM_OVERVIEW_TYPES } from "../lib/poe-ninja";
import { installRawResponseCache } from "./raw-response-cache";
import { CURRENT_LEAGUE } from "../lib/league-recency";

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

async function main() {
  installRawResponseCache(); // share poe.ninja responses with the other daily-job scripts - see raw-response-cache.ts
  const today = new Date().toISOString().slice(0, 10); // UTC calendar day, matching poe.ninja's own daily-snapshot convention
  const month = today.slice(0, 7); // YYYY-MM - see the module doc above for why files are chunked by month
  fs.mkdirSync(path.join(HISTORY_DIR, CURRENT_LEAGUE), { recursive: true });

  const currencyPath = `${CURRENT_LEAGUE}/${CURRENT_LEAGUE}.currency.${month}.csv`;
  const itemsPath = `${CURRENT_LEAGUE}/${CURRENT_LEAGUE}.items.${month}.csv`;

  const currencyRows: string[] = [];
  const itemRows: string[] = [];
  let nextId = 1;

  // Currency-overview types (see CURRENCY_OVERVIEW_TYPES's own comment in lib/poe-ninja.ts): only
  // Currency/Fragment are poe.ninja's own "currency.csv" style (an exchange PAIR); every other type
  // in that same live bucket (Scarab, Essence, DivinationCard, ...) is filed under "items.csv" in
  // poe.ninja's own historical export, keyed by CurrencyPrice.type below.
  const currencyPrices = await getAllCurrentCurrencyPrices(CURRENT_LEAGUE);
  for (const [name, price] of currencyPrices) {
    if (name === "Chaos Orb" || !(price.chaosValue > 0)) continue;
    if (price.type === "Currency" || price.type === "Fragment") {
      currencyRows.push([CURRENT_LEAGUE, today, name, "Chaos Orb", price.chaosValue, "High"].map(csvField).join(";"));
    } else {
      itemRows.push([CURRENT_LEAGUE, today, nextId++, price.type, name, "", "", "", price.chaosValue, "High"].map(csvField).join(";"));
    }
  }

  // Genuine equipment/gem types - the only ones with a real BaseType/Variant/Links to carry.
  for (const type of ITEM_OVERVIEW_TYPES) {
    const lines = await getItemOverview(CURRENT_LEAGUE, type);
    for (const line of lines) {
      if (!(line.chaosValue > 0)) continue;
      const links = typeof line.links === "number" ? linksBucketLabel(line.links) : "";
      itemRows.push(
        [
          CURRENT_LEAGUE,
          today,
          nextId++,
          correctedItemType(type, line.baseType),
          line.name,
          line.baseType ?? "",
          line.variant?.trim() ?? "",
          links,
          line.chaosValue,
          "High",
        ]
          .map(csvField)
          .join(";")
      );
    }
  }

  if (currencyRows.length === 0 || itemRows.length === 0) {
    throw new Error(`Suspiciously empty snapshot (${currencyRows.length} currency rows, ${itemRows.length} item rows) - refusing to publish.`);
  }

  const currencyHeader = "League;Date;Get;Pay;Value;Confidence";
  const itemsHeader = "League;Date;Id;Type;Name;BaseType;Variant;Links;Value;Confidence";

  const existingCurrency = await fetchExisting(currencyPath);
  const existingItems = await fetchExisting(itemsPath);
  // dateColumnIndex=1 for both schemas (Date is the second column in each).
  const currencyLines = dropExistingDay(existingCurrency, 1, today);
  const itemLines = dropExistingDay(existingItems, 1, today);

  const finalCurrency = (currencyLines.length > 0 ? currencyLines : [currencyHeader]).concat(currencyRows).join("\n") + "\n";
  const finalItems = (itemLines.length > 0 ? itemLines : [itemsHeader]).concat(itemRows).join("\n") + "\n";

  const currencyOut = path.join(HISTORY_DIR, currencyPath);
  const itemsOut = path.join(HISTORY_DIR, itemsPath);
  fs.writeFileSync(currencyOut, finalCurrency);
  fs.writeFileSync(itemsOut, finalItems);

  for (const [label, file] of [["currency", currencyOut], ["items", itemsOut]] as const) {
    const { size } = fs.statSync(file);
    console.log(`${label}.csv: ${(size / 1024 / 1024).toFixed(2)} MB`);
    if (size > MAX_SAFE_FILE_BYTES) {
      throw new Error(`${file} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_SAFE_FILE_BYTES / 1024 / 1024} MB safety threshold - GitHub rejects a push over 100MB without Git LFS. This shouldn't happen given monthly chunking (see the module doc) unless something changed a lot (e.g. a huge new item category) - stop and address it (Git LFS, a finer chunk than a month, ...) before it publishes a broken day.`);
    }
  }

  console.log(`Wrote ${currencyRows.length} new currency rows, ${itemRows.length} new item rows for ${CURRENT_LEAGUE} on ${today}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
