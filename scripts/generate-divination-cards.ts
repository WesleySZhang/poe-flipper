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
 * Prints the generated array for review - paste into lib/divination-cards.ts by hand, same
 * "generated, do not hand-edit the target file" convention as generate-faustus-mapping.ts.
 *
 *   npx tsx scripts/generate-divination-cards.ts
 */
const REPOE_BASE_ITEMS_URL = "https://repoe-fork.github.io/base_items.json";
const DIVINATION_CARD_PREFIX = "Metadata/Items/DivinationCards/";
const ABSTRACT_DIVINATION_CARD_ID = `${DIVINATION_CARD_PREFIX}AbstractDivinationCard`;

interface RePoEEntry {
  name: string;
  item_class: string;
  properties?: {
    stack_size?: number;
    description?: string;
  };
}

type RewardKind = "unique" | "currency" | "card";

interface DivinationCardDef {
  name: string;
  stackSize: number;
  rewardKind: RewardKind;
  rewardName: string;
  rewardQuantity: number;
}

const REWARD_TAG_TO_KIND: Record<string, RewardKind> = {
  uniqueitem: "unique",
  currencyitem: "currency",
  divination: "card",
  // All three priced as a plain base-type/currency lookup, same mechanism as currencyitem - see
  // this file's module doc for why magicitem/rareitem are folded in here despite carrying random
  // affixes in-game (deliberately priced AS the base type, not as the true randomized item).
  whiteitem: "currency",
  magicitem: "currency",
  rareitem: "currency",
};

// Matches "3x Chaos Orb" -> qty 3, name "Chaos Orb"; "1,500x Vivid Crystallised Lifeforce" -> qty
// 1500 (thousands separator stripped before parsing); a bare "Chaos Orb" (no "Nx " prefix) -> qty 1.
const QUANTITY_PREFIX = /^([\d,]+)x (.+)$/;

function parseReward(description: string): { tag: string; text: string }[] {
  return [...description.matchAll(/<(\w+)>\{([^}]*)\}/g)].map((m) => ({ tag: m[1], text: m[2] }));
}

function main() {
  return fetch(REPOE_BASE_ITEMS_URL, { headers: { "User-Agent": "Mozilla/5.0" } }).then(async (res) => {
    if (!res.ok) throw new Error(`RePoE fetch failed: ${res.status}`);
    const repoe = (await res.json()) as Record<string, RePoEEntry>;

    const cardEntries = Object.entries(repoe).filter(
      ([id, entry]) => id.startsWith(DIVINATION_CARD_PREFIX) && id !== ABSTRACT_DIVINATION_CARD_ID && entry.item_class === "DivinationCard"
    );
    console.log(`${cardEntries.length} divination card entries in RePoE's base_items.json.`);

    const cards: DivinationCardDef[] = [];
    let noStackSize = 0;
    let noSingleTag = 0;
    let unknownTag = 0;

    for (const [, entry] of cardEntries) {
      const stackSize = entry.properties?.stack_size;
      if (!stackSize || stackSize < 1) {
        noStackSize++;
        continue;
      }
      const description = entry.properties?.description ?? "";
      const parts = parseReward(description);
      // Multi-tag (randomized outcome, including a guaranteed-corrupted unique - see this file's
      // module doc for why that one stays excluded) and zero-tag (plain text / disabled)
      // descriptions are both out of scope - only a single, unambiguous <tag>{text} segment is a
      // deterministic reward.
      if (parts.length !== 1) {
        noSingleTag++;
        continue;
      }
      const rewardPart = parts[0];
      const rewardKind = REWARD_TAG_TO_KIND[rewardPart.tag];
      if (!rewardKind) {
        unknownTag++;
        continue;
      }
      const quantityMatch = rewardPart.text.match(QUANTITY_PREFIX);
      const rewardQuantity = quantityMatch ? Number(quantityMatch[1].replace(/,/g, "")) : 1;
      const rewardName = quantityMatch ? quantityMatch[2] : rewardPart.text;
      cards.push({ name: entry.name, stackSize, rewardKind, rewardName, rewardQuantity });
    }

    console.log(`${noStackSize} entries had no stack_size (skipped).`);
    console.log(`${noSingleTag} entries had a multi-tag or plain-text description (randomized outcome, skipped).`);
    console.log(`${unknownTag} entries had a reward tag this generator doesn't recognize yet (skipped) - review manually if > 0.`);
    console.log(`\nResolved ${cards.length} deterministic-reward cards.`);
    const byKind = { unique: 0, currency: 0, card: 0 };
    for (const c of cards) byKind[c.rewardKind]++;
    console.log(`  unique: ${byKind.unique}, currency: ${byKind.currency}, card: ${byKind.card}`);

    const sorted = cards.sort((a, b) => a.name.localeCompare(b.name));
    const lines = sorted.map(
      (c) =>
        `  { name: ${JSON.stringify(c.name)}, stackSize: ${c.stackSize}, rewardKind: ${JSON.stringify(c.rewardKind)}, rewardName: ${JSON.stringify(c.rewardName)}, rewardQuantity: ${c.rewardQuantity} },`
    );
    console.log(`\n=== Generated array (${sorted.length} entries) - review, then paste into lib/divination-cards.ts ===`);
    console.log(lines.join("\n"));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
