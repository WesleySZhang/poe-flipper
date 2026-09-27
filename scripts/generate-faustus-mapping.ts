/**
 * Regenerates lib/faustus.ts's FAUSTUS_NAME_TO_ID map. Run this again whenever a new league adds
 * Currency Exchange-tradeable items this app should pick up (a scarab rework, a new essence tier,
 * etc.) - not part of the running app itself. The daily scripts/check-new-items.ts job does this
 * automatically, add-only.
 *
 * Earlier attempts (see git history / this file's own history) tried deriving a display name from
 * each metadata id's own structure and validating it against known names - workable for Divination
 * Cards and Essences (their ids are self-describing enough), but Scarabs turned out to have a real
 * collision problem: several genuinely different, differently-priced tiers within one mechanic
 * (e.g. "Anarchy Scarab" vs "Anarchy Scarab of Gigantification") all derived to the same generic
 * name and validated as false positives.
 *
 * Uses RePoE (https://github.com/repoe-fork/repoe, an actively-maintained community mirror of PoE's
 * own game files - unofficial, but a direct machine-file dump rather than a guess) as ground truth
 * instead: every GGG metadata id it's ever seen maps directly to that item's real display name, no
 * derivation needed. Scoped to only the ids GGG's live Currency Exchange actually has open markets
 * for right now, so the generated map only ever contains genuinely tradeable items - never
 * speculative entries for something RePoE knows about but Faustus doesn't currently trade. Unique
 * items (e.g. "Vaal Aspect" base-type jewels like Cooperation - see lib/category-reliability.ts's
 * correctedItemType) are naturally excluded without any special-casing: they aren't stackable/
 * exchange-tradeable in the first place, so they never appear in GGG's exchange data to begin with.
 *
 * The fetching and parsing live in scripts/generated-data.ts (shared with check-new-items.ts).
 *
 *   npx tsx scripts/generate-faustus-mapping.ts [league]           # print the regenerated map
 *   npx tsx scripts/generate-faustus-mapping.ts [league] --write   # replace the map in lib/faustus.ts
 *
 * --write replaces the whole map with what is traded this hour, so a quiet item can drop out;
 * check-new-items.ts only ever adds.
 */
import { CURRENT_LEAGUE } from "../lib/league-recency";
import { buildFaustusMap, fetchExchangeIds, fetchRePoEBaseItems, formatFaustusEntries, writeFaustusMap } from "./generated-data";
import { writeFaustusDoc } from "./generate-faustus-doc";

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const league = args.find((a) => !a.startsWith("--")) || CURRENT_LEAGUE;
  console.log(`Fetching live ${league} exchange markets and RePoE's base item data...`);
  const [ids, repoe] = await Promise.all([fetchExchangeIds(league), fetchRePoEBaseItems()]);
  console.log(`${ids.size} distinct ids seen in live ${league} exchange data; ${Object.keys(repoe).length} RePoE entries.`);

  const { nameToId, noRepoeEntry, wrongClass, collisions } = buildFaustusMap(repoe, ids);
  console.log(`\nResolved ${nameToId.size} name->id pairs.`);
  console.log(`${noRepoeEntry.length} ids had no RePoE entry at all (sample):`, noRepoeEntry.slice(0, 10));
  console.log(`${wrongClass.length} ids had an unexpected item_class (sample):`, wrongClass.slice(0, 10));
  if (collisions.length > 0) {
    console.log(`${collisions.length} NAME COLLISIONS (two different ids claim the same name):`);
    collisions.forEach((c) => console.log(" ", c));
  }

  if (write) {
    const changed = writeFaustusMap(nameToId);
    writeFaustusDoc();
    console.log(changed ? "Wrote lib/faustus.ts and docs/faustus-mapping.md." : "lib/faustus.ts already up to date.");
  } else {
    console.log(`\n=== Generated map (${nameToId.size} entries) - pass --write to write it into lib/faustus.ts ===`);
    console.log(formatFaustusEntries(nameToId));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
