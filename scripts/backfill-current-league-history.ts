/**
 * ONE-TIME backfill: reconstructs the past several days of the current league's price history from
 * poe.ninja's own live 7-point sparkline (lib/poe-ninja.ts's SparkLine - real, poe.ninja-computed
 * daily data already trusted elsewhere in this app, e.g. as a model input feature and verified in
 * ml/README.md to match real stored history point-for-point - NOT fabricated), and merges the result
 * into the existing history/ CSVs on the "data" branch alongside whatever
 * scripts/precompute-price-history.ts has already collected for real.
 *
 * WHY: the daily collection job only just started, so the "data" branch currently has one real day
 * of history - not enough to see components/price-history-chart.tsx's new current-league line as
 * anything but a single point. The sparkline gives ~6 more real days of relative price movement for
 * free from the SAME live API call the daily job already makes each day; this reconstructs absolute
 * chaos values from it (spark[i]% is relative to a shared base, solved for using today's own live
 * price as the anchor) and writes them as ordinary historical rows.
 *
 * A day that's already in the file (today's real snapshot, or a previous run of this script) is left
 * completely untouched - this only ever ADDS rows for a date that isn't there yet, never overwrites
 * or duplicates one. Confidence is written as "Medium", not "High" like a real daily snapshot - this
 * is a same-day reconstruction from a rounded percentage, a notch less precise than the daily job's
 * own direct reading. Not meant to be a long-term data source: once this league ends, its real
 * poe.ninja historical export will have precise per-day data and should be used instead if this
 * league is ever formally ingested (see scripts/ingest-history.ts).
 *
 * Run once, locally: npx tsx --conditions=react-server scripts/backfill-current-league-history.ts
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
import { CURRENT_LEAGUE } from "../lib/league-recency";

const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
const HISTORY_DIR = path.join(__dirname, "..", "history");

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

function csvField(value: string | number): string {
  const s = String(value);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Every date (oldest first) a sparkline of this length reconstructs, EXCLUDING the last point
 *  (today - already collected for real by the daily job, left untouched here). */
function backfillDates(sparkLength: number, today: Date): string[] {
  const dates: string[] = [];
  for (let daysAgo = sparkLength - 1; daysAgo >= 1; daysAgo--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    dates.push(isoDate(d));
  }
  return dates;
}

/** Absolute chaos value per backfill date, reconstructed from a sparkline anchored on today's live
 *  price - undefined entries (a null spark point, no price that day) are skipped by the caller. */
function reconstructValues(spark: Array<number | null>, todayChaosValue: number): Array<number | undefined> {
  const lastPct = spark[spark.length - 1];
  if (lastPct === null) return spark.map(() => undefined);
  const base = todayChaosValue / (1 + lastPct / 100);
  // Every entry except the last (today, excluded by backfillDates above).
  return spark.slice(0, -1).map((pct) => (pct === null ? undefined : base * (1 + pct / 100)));
}

async function main() {
  const today = new Date();
  const todayIso = isoDate(today);

  // Rows keyed by month so multi-month backfills (a sparkline spanning a calendar boundary) split
  // into the right chunk files, same convention scripts/precompute-price-history.ts already uses.
  const currencyRowsByMonth = new Map<string, string[]>();
  const itemRowsByMonth = new Map<string, string[]>();
  let nextId = 1_000_000; // well clear of any Id the same day's real snapshot already assigned

  function addRow(byMonth: Map<string, string[]>, date: string, fields: (string | number)[]) {
    const month = date.slice(0, 7);
    const rows = byMonth.get(month) ?? [];
    rows.push(fields.map(csvField).join(";"));
    byMonth.set(month, rows);
  }

  const currencyPrices = await getAllCurrentCurrencyPrices(CURRENT_LEAGUE);
  let currencyReconstructed = 0;
  for (const [name, price] of currencyPrices) {
    if (name === "Chaos Orb" || !(price.chaosValue > 0) || !price.spark || price.spark.length < 2) continue;
    const dates = backfillDates(price.spark.length, today);
    const values = reconstructValues(price.spark, price.chaosValue);
    dates.forEach((date, i) => {
      const value = values[i];
      if (value === undefined || !(value > 0)) return;
      if (price.type === "Currency" || price.type === "Fragment") {
        addRow(currencyRowsByMonth, date, [CURRENT_LEAGUE, date, name, "Chaos Orb", value, "Medium"]);
      } else {
        addRow(itemRowsByMonth, date, [CURRENT_LEAGUE, date, nextId++, price.type, name, "", "", "", value, "Medium"]);
      }
      currencyReconstructed++;
    });
  }

  let itemReconstructed = 0;
  for (const type of ITEM_OVERVIEW_TYPES) {
    const lines = await getItemOverview(CURRENT_LEAGUE, type);
    for (const line of lines) {
      const spark = sparkPointsFrom(line.sparkLine);
      if (!(line.chaosValue > 0) || !spark || spark.length < 2) continue;
      const dates = backfillDates(spark.length, today);
      const values = reconstructValues(spark, line.chaosValue);
      const links = typeof line.links === "number" ? linksBucketLabel(line.links) : "";
      dates.forEach((date, i) => {
        const value = values[i];
        if (value === undefined || !(value > 0)) return;
        addRow(itemRowsByMonth, date, [
          CURRENT_LEAGUE,
          date,
          nextId++,
          correctedItemType(type, line.baseType),
          line.name,
          line.baseType ?? "",
          line.variant?.trim() ?? "",
          links,
          value,
          "Medium",
        ]);
        itemReconstructed++;
      });
    }
  }

  console.log(`Reconstructed ${currencyReconstructed} currency-day rows, ${itemReconstructed} item-day rows.`);
  if (currencyReconstructed === 0 && itemReconstructed === 0) {
    throw new Error("Nothing reconstructed - refusing to publish an empty backfill.");
  }

  const currencyHeader = "League;Date;Get;Pay;Value;Confidence";
  const itemsHeader = "League;Date;Id;Type;Name;BaseType;Variant;Links;Value;Confidence";

  fs.mkdirSync(path.join(HISTORY_DIR, CURRENT_LEAGUE), { recursive: true });

  const months = new Set([...currencyRowsByMonth.keys(), ...itemRowsByMonth.keys()]);
  for (const month of months) {
    const currencyPath = `${CURRENT_LEAGUE}/${CURRENT_LEAGUE}.currency.${month}.csv`;
    const itemsPath = `${CURRENT_LEAGUE}/${CURRENT_LEAGUE}.items.${month}.csv`;

    const existingCurrency = await fetchExisting(currencyPath);
    const existingItems = await fetchExisting(itemsPath);

    // Only ADD a date that isn't already present anywhere in the file - never touch a date that's
    // already there (a real daily snapshot, or a previous run of this same backfill).
    const existingCurrencyDates = new Set(
      (existingCurrency?.split(/\r?\n/) ?? []).slice(1).filter(Boolean).map((line) => line.split(";")[1])
    );
    const existingItemDates = new Set(
      (existingItems?.split(/\r?\n/) ?? []).slice(1).filter(Boolean).map((line) => line.split(";")[1])
    );

    const newCurrencyRows = (currencyRowsByMonth.get(month) ?? []).filter(
      (row) => !existingCurrencyDates.has(row.split(";")[1])
    );
    const newItemRows = (itemRowsByMonth.get(month) ?? []).filter((row) => !existingItemDates.has(row.split(";")[1]));

    const currencyLines = existingCurrency ? existingCurrency.split(/\r?\n/).filter(Boolean) : [currencyHeader];
    const itemLines = existingItems ? existingItems.split(/\r?\n/).filter(Boolean) : [itemsHeader];

    const finalCurrency = currencyLines.concat(newCurrencyRows).join("\n") + "\n";
    const finalItems = itemLines.concat(newItemRows).join("\n") + "\n";

    fs.writeFileSync(path.join(HISTORY_DIR, currencyPath), finalCurrency);
    fs.writeFileSync(path.join(HISTORY_DIR, itemsPath), finalItems);
    console.log(
      `${month}: +${newCurrencyRows.length} currency rows (${currencyRowsByMonth.get(month)?.length ?? 0} candidate, ${(currencyRowsByMonth.get(month)?.length ?? 0) - newCurrencyRows.length} already present), +${newItemRows.length} item rows`
    );
  }

  console.log(`Done. Today (${todayIso}) itself was not touched - only earlier days were backfilled.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
