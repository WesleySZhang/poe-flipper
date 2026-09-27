/**
 * Regenerates lib/divination-cards.ts's DIVINATION_CARDS array. Run this again whenever a new
 * league adds divination cards this app should pick up - not part of the running app itself.
 *
 * Uses RePoE (https://github.com/repoe-fork/repoe, an actively-maintained community mirror of
 * PoE's own game files - the same source scripts/generate-faustus-mapping.ts trusts for its
 * name<->id map) as ground truth for two things nothing else in this repo tracks: a card's stack
 * size, and its reward, both found in base_items.json's `properties` block for each
 * `Metadata/Items/DivinationCards/*` entry:
 *   - `stack_size`: the exact number of copies needed to turn the card in.
 *   - `description`: a small markup string tagging the reward, e.g. `<uniqueitem>{Mageblood}`,
 *     `<currencyitem>{3x Chaos Orb}`, `<divination>{The Doctor}` for a deterministic reward, or
 *     (for a non-deterministic one) multiple tags like `<uniqueitem>{Headhunter}\r\n<corrupted>
 *     {Corrupted}`, a bare category placeholder like `<uniqueitem>{Axe}`/`{Item}`, or plain text
 *     like "Disabled" for a currently vendor-recipe-only card.
 *
 * A card is only emitted when its description resolves to EXACTLY ONE <tag>{text} segment - a
 * multi-tag description means a randomized outcome (a roll, a corruption, a random item of a
 * category) that can't be priced from a single number, which this app's divination-flips feature
 * deliberately excludes (see lib/divination-flips.ts). This INCLUDES <uniqueitem>{X}
 * <corrupted>{Corrupted} - even though the item itself is guaranteed and identifiable, a corrupted
 * unique typically trades for LESS than its pristine price (not a rounding-error-sized difference),
 * and poe.ninja doesn't track a separate corrupted price point to measure that gap from - so rather
 * than model a real, meaningful discount this app has no data for, these are excluded outright.
 *
 * Recognizes six reward tags now, not the original three: uniqueitem, currencyitem, divination,
 * whiteitem, magicitem, and rareitem. The latter three all map to the same "currency" reward kind
 * as currencyitem (same lookup: poe.ninja's currency/Scarab/Fragment/BaseType price map, not the
 * equippable-unique one) and are treated identically here despite their different in-game
 * rarities:
 *   - whiteitem: a specific NAMED Normal-rarity item, zero affixes, no randomness at all (e.g.
 *     "Sulphite Scarab", "Divine Vessel").
 *   - magicitem/rareitem: the base item's identity (and, for gear, its link count) is still fixed
 *     and guaranteed, but the actual affixes rolled onto it are random - by design, this is priced
 *     as if it were just the plain BASE TYPE (e.g. a card whose text reads "Six-Link Astral Plate"
 *     under a rareitem tag is priced the exact same way as one that reads it under whiteitem),
 *     deliberately ignoring whatever the rolled affixes might add. This is a real simplification,
 *     not a precise number for what you'll actually receive - but the base type itself is usually
 *     most of a low/mid-tier magic or rare reward's value anyway, and there's no live data source
 *     for "this specific rare item with unknown future affixes" to do better than that.
 *
 * None of this step can tell a real reward name ("Mageblood", "Sulphite Scarab") apart from a
 * single-tag placeholder ("Axe", "Map", "Scarab") or a currently-untracked/misremembered one - that
 * needs checking against live price data, which happens at request time in
 * lib/divination-flips.ts, not here (price coverage changes week to week; RePoE's game-file data
 * doesn't). A card whose "specific" name doesn't actually match anything live just gets skipped
 * there, same as always - this generator only needs to get the CANDIDATE list right.
 *
 * The parsing lives in scripts/generated-data.ts (shared with the daily scripts/check-new-items.ts
 * job, which runs this automatically).
 *
 *   npx tsx scripts/generate-divination-cards.ts           # print the generated array
 *   npx tsx scripts/generate-divination-cards.ts --write   # write it into lib/divination-cards.ts
 */
import { buildDivinationCards, fetchRePoEBaseItems, formatCardLines, writeDivinationCards } from "./generated-data";

async function main() {
  const write = process.argv.includes("--write");
  const r = buildDivinationCards(await fetchRePoEBaseItems());
  console.log(`${r.total} divination card entries in RePoE's base_items.json.`);
  console.log(`${r.noStackSize} entries had no stack_size (skipped).`);
  console.log(`${r.noSingleTag} entries had a multi-tag or plain-text description (randomized outcome, skipped).`);
  console.log(`${r.unknownTag} entries had a reward tag this generator doesn't recognize yet (skipped) - review manually if > 0.`);
  const byKind = { unique: 0, currency: 0, card: 0 };
  for (const c of r.cards) byKind[c.rewardKind]++;
  console.log(`\nResolved ${r.cards.length} deterministic-reward cards (unique: ${byKind.unique}, currency: ${byKind.currency}, card: ${byKind.card}).`);

  if (write) {
    console.log(writeDivinationCards(r.cards) ? "Wrote lib/divination-cards.ts." : "lib/divination-cards.ts already up to date.");
  } else {
    console.log(`\n=== Generated array (${r.cards.length} entries) - pass --write to write it into lib/divination-cards.ts ===`);
    console.log(formatCardLines(r.cards));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
