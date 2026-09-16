/**
 * Gold cost of trading an item on GGG's Currency Exchange (the "Faustus" NPC).
 *
 * GGG's exchange API carries no gold/fee field at all (checked every key across every market in
 * the live response), and there's no machine-readable source for it either, so this table is
 * transcribed by hand from the PoE wiki's Currency Exchange page - the wiki itself sits behind a
 * bot-detection challenge (Anubis), so it can't be fetched or auto-refreshed; update this by hand
 * when the wiki's numbers change.
 *
 * The cost is charged PER ITEM on the "want"/buy side of an order, so a flip's total gold spend is
 * (units bought x costPerItem) - see components/currency-exchange-flip-panel.tsx for how that turns into a
 * "chaos profit per 1000 gold" ranking, which is the number that matters once gold (not chaos) is
 * the binding constraint on how much you can flip in a day.
 *
 * Every mapping below is grounded in a real display name from docs/faustus-mapping.md (generated
 * from RePoE - see lib/faustus.ts's header) or the wiki's own text - nothing here is a guess about
 * which name a bucket applies to. Two honest gaps are marked explicitly rather than papered over:
 *   - `approximate: true` - the wiki only gives a RANGE for a whole family (Scarabs 100-500,
 *     Divination Cards 15-1850, ...), not a per-item tier, so the returned value is a representative
 *     estimate, not the real number for that specific item.
 *   - `undefined` (no gold shown at all) - the wiki's table doesn't cover this item. Notably this
 *     includes Chromatic Orb (the wiki lists it as "?"), every Hellscape "Tainted" variant besides
 *     Tainted Catalyst/Oil (a different, newer mechanic the classic table predates), and every
 *     Allflame-league Deepwater/Ducat and Zorath's Eye item (same reason).
 */

export interface GoldCost {
  /** Gold charged per single item bought. Fractional for items priced per-stack (e.g. lifeforce). */
  perItem: number;
  /** True when the source only gives a range/family estimate rather than this exact item's cost. */
  approximate: boolean;
  /** Shown on hover when approximate, explaining what the estimate is based on. */
  note?: string;
}

const exact = (perItem: number): GoldCost => ({ perItem, approximate: false });
const approx = (perItem: number, note: string): GoldCost => ({ perItem, approximate: true, note });

/** Individually-named items the wiki gives a single, unambiguous cost for. */
const EXACT_COSTS: Readonly<Record<string, number>> = {
  "Portal Scroll": 1,
  "Scroll of Wisdom": 1,
  "Orb of Transmutation": 3,
  "Orb of Augmentation": 5,
  "Jeweller's Orb": 10,
  "Orb of Chance": 10,
  "Orb of Alteration": 10,
  "Chaos Orb": 15,
  "Orb of Fusing": 15,
  "Orb of Alchemy": 15,
  "Orb of Scouring": 15,
  "Exalted Orb": 20,
  "Regal Orb": 20,
  "Orb of Regret": 20,
  "Orb of Unmaking": 20,
  "Vaal Orb": 20,
  "Orb of Binding": 20,
  "Instilling Orb": 20,
  "Armourer's Scrap": 25,
  "Blacksmith's Whetstone": 30,
  "Blessed Orb": 35,
  "Enkindling Orb": 35,
  "Stacked Deck": 35,
  "Gemcutter's Prism": 50,
  "Glassblower's Bauble": 50,
  "Divine Orb": 250,
  "Orb of Annulment": 250,
  "Ancient Orb": 250,
  "Veiled Chaos Orb": 250,
  "Sacred Orb": 250,
  "Tempering Orb": 250,
  "Tailoring Orb": 250,
  "Fracturing Orb": 500,
  "Veiled Exalted Orb": 500,
  "Sacred Crystallised Lifeforce": 125,
  "Valdo's Puzzle Box": 300,
  "Voidborn Reliquary Key": 975,
  "Mirror Shard": 1250,
  "Mirror of Kalandra": 25000,
  "Hinekora's Lock": 6250,
  // Priced per stack on the wiki ("1 gold per 8", "1 gold per 1000") rather than per single item.
  "Crystallised Lifeforce": 1 / 8,
  "Rogue's Marker": 1 / 1000,

  // Conqueror Exalted Orbs - "influenced exalted orbs" is a flat 500 per the wiki.
  "Hunter's Exalted Orb": 500,
  "Redeemer's Exalted Orb": 500,
  "Crusader's Exalted Orb": 500,
  "Warlord's Exalted Orb": 500,

  // Maven's Chisels - single flat value, all five variants.
  "Maven's Chisel of Avarice": 200,
  "Maven's Chisel of Divination": 200,
  "Maven's Chisel of Procurement": 200,
  "Maven's Chisel of Proliferation": 200,
  "Maven's Chisel of Scarabs": 200,

  // Fragments with a single flat value on the wiki.
  "An Audience With The King": 250,
  Simulacrum: 250,
  "Syndicate Medallion": 250,
  "Sacred Blossom": 250,
  "Ritual Vessel": 250,
  "The Maven's Writ": 1000,
  "Hivebrain Gland": 500,
  // "Shaper/Elder ... frag" = 250; the four Shaper fragments plus the four base Elder fragments
  // (not the Uber Elder ones, which are 500 - see below).
  "Fragment of the Chimera": 250,
  "Fragment of the Hydra": 250,
  "Fragment of the Minotaur": 250,
  "Fragment of the Phoenix": 250,
  "Fragment of Constriction": 250,
  "Fragment of Enslavement": 250,
  "Fragment of Eradication": 250,
  "Fragment of Purification": 250,
  // Sirus's four general crests - the wiki's "Sirus frag" line, same 250 as Shaper/Elder.
  "Al-Hezmin's Crest": 250,
  "Baran's Crest": 250,
  "Drox's Crest": 250,
  "Veritania's Crest": 250,
  // Uber Elder fragments - 500, distinct from the base Elder fragments above.
  "Fragment of Emptiness": 500,
  "Fragment of Knowledge": 500,
  "Fragment of Shape": 500,
  "Fragment of Terror": 500,
  // "Uber fragments 500" - every other uber-boss-key fragment (id contains UberBossKey, excluding
  // the Uber Elder ones above which are matched by name already).
  "Awakening Fragment": 500,
  "Blazing Fragment": 500,
  "Cosmic Fragment": 500,
  "Decaying Fragment": 500,
  "Devouring Fragment": 500,
  "Lonely Fragment": 500,
  "Reality Fragment": 500,
  "Reverent Fragment": 500,
  "Synthesising Fragment": 500,
  "Traumatic Fragment": 500,
  // NOTE: "Memory lines 1,000" from the wiki is deliberately NOT mapped here. Two distinct item
  // families exist for this content - "Memory of X" (plain currency, id ends "MemoryThread") and
  // "Echo of X" (a boss-access key, id under MapFragments/AtlasMemory/..Key) - and it isn't clear
  // from the wiki text which one "Memory lines" refers to. Guessing would misprice whichever one is
  // wrong, so both are left with no gold data rather than picking one.
};

/** Eldritch currency tiers the wiki lists in ascending order (35, 50, 75, 200). */
const ELDRITCH_TIERS: Readonly<Record<string, number>> = {
  Lesser: 35,
  Greater: 50,
  Grand: 75,
  Exceptional: 200,
};

/** Delve resonators, by the tier word in the name (5, 10, 15, 25 ascending). */
const RESONATOR_TIERS: Readonly<Record<string, number>> = {
  Primitive: 5,
  Potent: 10,
  Powerful: 15,
  Prime: 25,
};

/**
 * The three Foulborn currencies (Hellscape mechanic) against the wiki's three values (500, 750,
 * 1000), assigned by the same rarity ordering their base-currency counterparts already follow
 * (Augmentation < Regal < Exalted) - the wiki gives the three numbers but not which currency gets
 * which, so this ordering is the best available inference rather than a confirmed mapping. Flagged
 * approximate for exactly that reason.
 */
const FOULBORN_COSTS: Readonly<Record<string, number>> = {
  "Foulborn Orb of Augmentation": 500,
  "Foulborn Regal Orb": 750,
  "Foulborn Exalted Orb": 1000,
};

const DIVINATION_CARD_ID_PREFIX = "Metadata/Items/DivinationCards/";

/**
 * Cost for one exchange-tradeable item by display name, or undefined when the source doesn't cover
 * it at all. Name-pattern rules only cover families where the tier is genuinely recoverable from the
 * name (Eldritch ichor/ember, resonators); everything else either matches EXACT_COSTS by name or
 * falls back to a flagged family estimate - never a fabricated per-item guess.
 *
 * `id` is the item's GGG metadata id (lib/faustus.ts's FAUSTUS_NAME_TO_ID value for this name) -
 * needed only to recognise Divination Cards, whose flavour-text names can't be matched by a pattern.
 * Optional so this stays testable/callable on a name alone for every other family.
 */
export function goldCostFor(name: string, id?: string): GoldCost | undefined {
  if (id?.startsWith(DIVINATION_CARD_ID_PREFIX)) {
    return approx(200, "Divination cards range 15-1850 gold per card");
  }
  const exactCost = EXACT_COSTS[name];
  if (exactCost !== undefined) return exact(exactCost);

  const foulbornCost = FOULBORN_COSTS[name];
  if (foulbornCost !== undefined) return approx(foulbornCost, "Foulborn currency is 500, 750 or 1000 - exact assignment per item isn't published");

  if (/^(Lesser|Greater|Grand|Exceptional) Eldritch (Ichor|Ember)$/.test(name)) {
    return exact(ELDRITCH_TIERS[name.split(" ")[0]]);
  }
  if (/^(Primitive|Potent|Powerful|Prime) (Alchemical|Chaotic) Resonator$/.test(name)) {
    return exact(RESONATOR_TIERS[name.split(" ")[0]]);
  }

  // Families the wiki only gives a range for - representative (mean-ish) value, flagged as an
  // estimate. Matched on the same name shape confirmed against docs/faustus-mapping.md's listings.
  if (name.endsWith(" Scarab") || name.includes(" Scarab of ") || name.startsWith("Scarab of ")) {
    return approx(125, "Scarabs range 100-500 gold by tier");
  }
  if (name.includes("Essence of ")) {
    return approx(50, "Essences range 25-75 gold by tier");
  }
  if (name.endsWith(" Fossil")) return approx(45, "Fossils range 30-100 gold by type");
  if (name === "Tainted Catalyst") return exact(150);
  if (name.endsWith(" Catalyst")) return approx(38, "Catalysts are 25 or 50 gold (tainted is 150)");
  if (name === "Tainted Oil") return exact(500);
  if (name.endsWith(" Oil")) return approx(75, "Oils range 25-125 gold");
  if (name.startsWith("Omen of ")) return approx(50, "Omens are 25, 50 or 125 gold");
  if (name.includes("Tattoo of")) return approx(50, "Tattoos are 25, 50 or 125 gold");
  if (name === "Delirium Orb" || name.endsWith(" Delirium Orb")) return approx(150, "Delirium orbs range 75-250 gold");
  if (name.includes("Runegraft")) return approx(500, "Runegrafts are 500 gold (angler is 5000)");
  if (/^Timeless \w+ Emblem$/.test(name)) return approx(350, "Legion emblems range 50-750 gold by tier");
  if (name.endsWith(" Astrolabe")) return exact(1000);

  // Vaal fragments - Atziri (Sacrifice at ...) and Uber Atziri (Mortal ...), both ranges.
  if (/^Sacrifice at (Dawn|Dusk|Midnight|Noon)$/.test(name)) {
    return approx(35, "Atziri fragments range 15-75 gold");
  }
  if (/^Mortal (Grief|Hope|Ignorance|Rage)$/.test(name)) {
    return approx(90, "Uber Atziri fragments range 40-190 gold");
  }
  if (name.includes("Offering to the Goddess") || name.endsWith("to the Goddess")) {
    return approx(105, "Goddess offerings are 30 or 180 gold");
  }

  return undefined;
}
