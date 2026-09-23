/**
 * Writes prices.json at the repo root: today's whole poe.ninja price map (every currency and item
 * with its type, sparkline and seller count) plus which category buckets had any listings at all.
 * The daily GitHub Actions workflow (.github/workflows/precompute-predictions.yml) publishes it to
 * the "data" branch alongside predictions.json; lib/price-snapshot.ts reads it back so the running
 * app doesn't have to call poe.ninja itself for anything that doesn't need to be fresher than the
 * predictions are.
 *
 * Always fetches every category (no `activeTypes` filter) - it's how the active list gets built in
 * the first place, so it can't depend on yesterday's copy of that list.
 *
 * Not part of the running app. Run:  npx tsx scripts/precompute-price-snapshot.ts
 */
import fs from "node:fs";
import path from "node:path";
import { getAllCurrentCurrencyPrices, getAllCurrentItemPrices, getItemOverview, ITEM_OVERVIEW_TYPES } from "../lib/poe-ninja";
import { CURRENT_LEAGUE } from "../lib/league-recency";
import { buildPriceSnapshot } from "../lib/price-snapshot";
import { installRawResponseCache } from "./raw-response-cache";

const OUTPUT_PATH = path.join(__dirname, "..", "prices.json");

async function main() {
  installRawResponseCache();
  const [currencyPrices, itemPrices] = await Promise.all([
    getAllCurrentCurrencyPrices(CURRENT_LEAGUE),
    getAllCurrentItemPrices(CURRENT_LEAGUE),
  ]);
  // Counted from the raw per-type responses (cached by the calls above), not the merged map - a
  // type's lines can be re-bucketed there (lib/poe-ninja.ts's correctedItemType), which would make
  // a type look empty when poe.ninja actually returned lines for it.
  const activeItemTypes: string[] = [];
  for (const type of ITEM_OVERVIEW_TYPES) {
    if ((await getItemOverview(CURRENT_LEAGUE, type)).length > 0) activeItemTypes.push(type);
  }

  // Same guard as precompute-predictions.ts: an empty result means poe.ninja failed silently.
  if (currencyPrices.size < 50 || itemPrices.size < 1000) {
    throw new Error(
      `Suspiciously small price snapshot (${currencyPrices.size} currency, ${itemPrices.size} items) - refusing to publish.`
    );
  }

  const snapshot = buildPriceSnapshot(CURRENT_LEAGUE, currencyPrices, itemPrices, activeItemTypes);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot));
  const { size } = fs.statSync(OUTPUT_PATH);
  console.log(
    `prices.json: ${(size / 1024 / 1024).toFixed(2)} MB, ${currencyPrices.size} currency, ${itemPrices.size} items, ` +
      `active types: ${snapshot.activeCurrencyTypes.length} currency / ${activeItemTypes.length} item`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
