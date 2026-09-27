/**
 * Finds items and categories a new league added that this app's generated/hand-kept lists don't know
 * about yet, fixes what it can, and writes a report of what needs a human. Run daily by
 * .github/workflows/check-new-items.yml, which opens a pull request when any file changed - the same
 * "detect automatically, a human merges" split as the league-swap job, since these lists feed live
 * prices to every visitor.
 *
 * Fixed automatically:
 *  - poe.ninja categories the app never requests: appended to CURRENCY_OVERVIEW_TYPES (exchange-priced)
 *    or ITEM_OVERVIEW_TYPES (stash-priced) in lib/poe-ninja.ts, and their page slug to
 *    lib/ninja-link.ts's CATEGORY_SLUGS - all read from poe.ninja's own category config.
 *  - Currency Exchange names missing from lib/faustus.ts's FAUSTUS_NAME_TO_ID (add-only: which ids have
 *    an open market changes hour to hour, so an entry is never removed just for being quiet), then
 *    docs/faustus-mapping.md is regenerated.
 *  - lib/divination-cards.ts's DIVINATION_CARDS, fully regenerated from RePoE (deterministic).
 *
 * Reported for a human (can't be derived from any source):
 *  - gold costs for new exchange names (lib/faustus-gold.ts, transcribed from community sources);
 *  - where a new category belongs in the category filter (lib/category-reliability.ts);
 *  - categories the app requests that poe.ninja no longer lists (not removed: past-league history
 *    may still use them);
 *  - exchange ids RePoE doesn't know yet.
 *
 *   npx tsx scripts/check-new-items.ts            # apply fixes, print the report
 *   npx tsx scripts/check-new-items.ts --dry-run  # report only, change nothing
 *
 * In CI: writes GitHub step outputs `changed` (true when a file changed) and the report to
 * $REPORT_PATH (default: new-items-report.md in the OS temp dir), and appends it to the job summary.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENCY_OVERVIEW_TYPES, ITEM_OVERVIEW_TYPES } from "../lib/poe-ninja";
import { CATEGORY_SLUGS } from "../lib/ninja-link";
import { goldCostFor } from "../lib/faustus-gold";
import { CURRENT_LEAGUE } from "../lib/league-recency";
import {
  ROOT,
  buildDivinationCards,
  buildFaustusMap,
  fetchExchangeIds,
  fetchNinjaCategories,
  fetchRePoEBaseItems,
  insertBeforeBlockEnd,
  readDivinationCardNames,
  readFaustusMap,
  writeDivinationCards,
  writeFaustusMap,
} from "./generated-data";
import { writeFaustusDoc } from "./generate-faustus-doc";

const POE_NINJA_PATH = path.join(ROOT, "lib", "poe-ninja.ts");
const NINJA_LINK_PATH = path.join(ROOT, "lib", "ninja-link.ts");

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const league = CURRENT_LEAGUE;
  const auto: string[] = []; // what this run changed
  const manual: string[] = []; // what a human needs to do
  const info: string[] = []; // worth knowing, no action
  const changedFiles = new Set<string>();

  // --- poe.ninja categories ----------------------------------------------------------------
  const categories = await fetchNinjaCategories(league);
  const known = new Set<string>([...CURRENCY_OVERVIEW_TYPES, ...ITEM_OVERVIEW_TYPES]);
  const newCategories = categories.filter((c) => !known.has(c.type));
  const newExchange = newCategories.filter((c) => c.views.includes("exchange"));
  const newStash = newCategories.filter((c) => !c.views.includes("exchange"));
  const missingSlugs = categories.filter((c) => known.has(c.type) && !CATEGORY_SLUGS[c.type]);
  const gone = [...known].filter((t) => !categories.some((c) => c.type === t));

  if (newCategories.length > 0) {
    auto.push(
      `Added ${newCategories.length} poe.ninja categories the app never requested: ` +
        newCategories.map((c) => `\`${c.type}\` (${c.views.includes("exchange") ? "exchange" : "stash"})`).join(", ")
    );
    manual.push(
      `Decide where the new categories go in the category filter (\`lib/category-reliability.ts\`); until then they sit in "Etc." and are hidden by default: ${newCategories.map((c) => `\`${c.type}\``).join(", ")}`
    );
  }
  if (missingSlugs.length > 0) {
    auto.push(`Added poe.ninja page slugs for existing categories: ${missingSlugs.map((c) => `\`${c.type}\``).join(", ")}`);
  }
  if (gone.length > 0) {
    info.push(`The app still requests categories poe.ninja no longer lists (left in place): ${gone.map((t) => `\`${t}\``).join(", ")}`);
  }
  if (!dryRun) {
    if (insertBeforeBlockEnd(POE_NINJA_PATH, "export const CURRENCY_OVERVIEW_TYPES = [", "\n] as const;", newExchange.map((c) => `  ${JSON.stringify(c.type)},`)))
      changedFiles.add(POE_NINJA_PATH);
    if (insertBeforeBlockEnd(POE_NINJA_PATH, "export const ITEM_OVERVIEW_TYPES = [", "\n] as const;", newStash.map((c) => `  ${JSON.stringify(c.type)},`)))
      changedFiles.add(POE_NINJA_PATH);
    const slugLines = [...newCategories, ...missingSlugs].map((c) => `  ${c.type}: ${JSON.stringify(c.url)},`);
    if (insertBeforeBlockEnd(NINJA_LINK_PATH, "export const CATEGORY_SLUGS: Record<string, string> = {", "\n};", slugLines))
      changedFiles.add(NINJA_LINK_PATH);
  }

  // --- RePoE-backed lists ------------------------------------------------------------------
  const repoe = await fetchRePoEBaseItems();

  // Currency Exchange name map (add-only).
  const existingMap = readFaustusMap();
  let exchangeIds: Set<string> | undefined;
  try {
    exchangeIds = await fetchExchangeIds(league);
  } catch (err) {
    info.push(`Skipped the Currency Exchange check: ${(err as Error).message}`);
  }
  if (exchangeIds) {
    const built = buildFaustusMap(repoe, exchangeIds);
    const existingIds = new Set(existingMap.values());
    const added = [...built.nameToId].filter(([name, id]) => !existingMap.has(name) && !existingIds.has(id));
    if (added.length > 0) {
      auto.push(`Added ${added.length} Currency Exchange names: ${added.map(([n]) => n).join(", ")}`);
      const noGold = added.filter(([name, id]) => {
        const cost = goldCostFor(name, id);
        return !cost || cost.approximate;
      });
      if (noGold.length > 0) {
        manual.push(`Add gold costs to \`lib/faustus-gold.ts\` for: ${noGold.map(([n]) => n).join(", ")}`);
      }
      if (!dryRun) {
        const merged = new Map(existingMap);
        for (const [name, id] of added) merged.set(name, id);
        if (writeFaustusMap(merged)) changedFiles.add("lib/faustus.ts");
        if (writeFaustusDoc()) changedFiles.add("docs/faustus-mapping.md");
      }
    }
    if (built.noRepoeEntry.length > 0) {
      info.push(`${built.noRepoeEntry.length} traded ids have no RePoE entry yet (RePoE may lag a new patch): ${built.noRepoeEntry.slice(0, 15).join(", ")}${built.noRepoeEntry.length > 15 ? ", ..." : ""}`);
    }
    if (built.collisions.length > 0) {
      info.push(`Name collisions (two ids, one name; first kept): ${built.collisions.join("; ")}`);
    }
  }

  // Divination cards (full regeneration).
  const cardsBefore = new Set(readDivinationCardNames());
  const cardResult = buildDivinationCards(repoe);
  const cardsAfter = new Set(cardResult.cards.map((c) => c.name));
  const cardsAdded = [...cardsAfter].filter((n) => !cardsBefore.has(n));
  const cardsRemoved = [...cardsBefore].filter((n) => !cardsAfter.has(n));
  if (cardsAdded.length > 0) auto.push(`Added ${cardsAdded.length} divination cards: ${cardsAdded.join(", ")}`);
  if (cardsRemoved.length > 0) {
    auto.push(`Removed ${cardsRemoved.length} divination cards whose reward is no longer a single fixed item in RePoE: ${cardsRemoved.join(", ")}`);
  }
  if (cardResult.unknownTagCards.length > 0) {
    manual.push(
      `Cards skipped for a reward tag \`scripts/generated-data.ts\` doesn't recognise (support the tag if it's a fixed reward): ${cardResult.unknownTagCards.join("; ")}`
    );
  }
  // Rewrite even with no name change: a stack size or reward can change for an existing card.
  if (!dryRun && writeDivinationCards(cardResult.cards)) changedFiles.add("lib/divination-cards.ts");

  // --- Report ------------------------------------------------------------------------------
  const changed = changedFiles.size > 0;
  const lines = [
    `## New items check (${league})`,
    "",
    dryRun ? "_Dry run: nothing was changed._" : changed ? `Changed: ${[...changedFiles].map((f) => `\`${path.relative(ROOT, path.resolve(ROOT, f)).replace(/\\/g, "/")}\``).join(", ")}` : "No changes needed.",
    "",
  ];
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`### ${title}`, "", ...items.map((i) => `- ${i}`), "");
  };
  section(dryRun ? "Would change" : "Changed automatically", auto);
  section("Needs a human", manual);
  section("For information", info);
  if (changed) {
    lines.push(
      "### After merging",
      "",
      "- Run the **Precompute predictions** workflow so the daily price snapshot picks up any new categories.",
      "- New items have no past-league history, so they get prices and links but no forecast until a league with them is ingested and the model retrained.",
      ""
    );
  }
  const report = lines.join("\n");
  console.log(report);

  const reportPath = process.env.REPORT_PATH || path.join(os.tmpdir(), "new-items-report.md");
  fs.writeFileSync(reportPath, report);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
