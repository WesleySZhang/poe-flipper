/**
 * Gold cost of trading an item on GGG's Currency Exchange (the "Faustus" NPC).
 *
 * GGG's exchange API carries no gold/fee field at all (checked every key across every market in
 * the live response), and there's no machine-readable source for it either, so this table is
 * transcribed by hand. Primary source: poedb.tw's Currency Exchange page
 * (https://poedb.tw/us/Currency_Exchange), which lists a specific per-item gold cost rather than a
 * family range - used for every category it covers (Currency, Eldritch currency, Currency Shards,
 * Quality/Influenced/Tainted currency, Astrolabes, Memories, Breach, Essences, Fossils, Resonators,
 * Scarabs, Divination Cards). Fallback source: the PoE wiki's Currency Exchange page, for the
 * categories poedb's page didn't yield when fetched (Oils, Catalysts, Omens, Tattoos, Delirium
 * Orbs, and most Fragments) - the wiki only gives a RANGE for these, not a per-item value, and it
 * sits behind a bot-detection challenge (Anubis) so it can't be scraped for anything more precise.
 * Both sources need updating by hand if their numbers change.
 *
 * Every mapping below is grounded in a real display name from docs/faustus-mapping.md (generated
 * from RePoE - see lib/faustus.ts's header) - nothing here is a guess about which name a value
 * applies to; a source name that doesn't match a real name here is simply never used. Two honest
 * gaps are marked explicitly rather than papered over:
 *   - `approximate: true` - only the wiki-fallback categories still hit this: a family range
 *     (Oils 25-125, Delirium Orbs 75-250, ...), not a per-item tier, so the returned value is a
 *     representative estimate, not the real number for that specific item.
 *   - `undefined` (no gold shown at all) - neither source covers this item. Notably this includes
 *     Chromatic Orb was resolved (poedb: 20) but several Allflame-league Deepwater/Ducat and
 *     Zorath's Eye items, plus "Echo of X" (see the Memory Lines note below), remain uncovered.
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

/** Individually-named items with a single, unambiguous cost (poedb.tw unless noted). */
const EXACT_COSTS: Readonly<Record<string, number>> = {
  // --- Basic currency ---
  "Portal Scroll": 1,
  "Scroll of Wisdom": 1,
  "Orb of Transmutation": 3,
  "Orb of Augmentation": 5,
  "Orb of Chance": 10,
  "Orb of Alteration": 10,
  "Jeweller's Orb": 10,
  "Chromatic Orb": 20,
  "Orb of Fusing": 15,
  "Orb of Alchemy": 15,
  "Chaos Orb": 15,
  "Orb of Scouring": 15,
  "Orb of Regret": 20,
  "Vaal Orb": 20,
  "Orb of Binding": 20,
  "Instilling Orb": 20,
  "Orb of Unmaking": 20,
  "Blessed Orb": 35,
  "Enkindling Orb": 35,
  "Regal Orb": 20,
  "Divine Vessel": 150,
  "Exalted Orb": 20,
  "Ancient Orb": 250,
  "Stacked Deck": 35,
  "Valdo's Puzzle Box": 300,
  "Divine Orb": 250,
  "Orb of Annulment": 250,
  "Voidborn Reliquary Key": 975,
  "Reflecting Mist": 500,
  "Tempering Orb": 250,
  "Tailoring Orb": 250,
  "Fracturing Orb": 500,
  "Veiled Chaos Orb": 250,
  "Veiled Exalted Orb": 500,
  "Sacred Orb": 250,
  "Hinekora's Lock": 6250,
  "Mirror of Kalandra": 25000,
  "Armourer's Scrap": 25,
  "Blacksmith's Whetstone": 30,
  "Glassblower's Bauble": 50,
  "Gemcutter's Prism": 50,
  // Priced per stack on the source ("1 gold per 8", "1 gold per 1000") rather than per single item.
  "Crystallised Lifeforce": 1 / 8,
  "Sacred Crystallised Lifeforce": 125,
  "Rogue's Marker": 1 / 1000,

  // --- Currency Shards ---
  "Transmutation Shard": 1 / 4,
  "Fracturing Shard": 25,
  "Mirror Shard": 1250,

  // --- Eldritch currency (base orbs; tiered ichor/ember handled by pattern below) ---
  "Eldritch Chaos Orb": 525,
  "Eldritch Exalted Orb": 525,
  "Eldritch Orb of Annulment": 525,
  "Orb of Conflict": 1050,

  // --- Influenced currency ---
  "Shaper's Exalted Orb": 500,
  "Elder's Exalted Orb": 500,
  "Crusader's Exalted Orb": 500,
  "Redeemer's Exalted Orb": 500,
  "Hunter's Exalted Orb": 500,
  "Warlord's Exalted Orb": 500,
  "Awakener's Orb": 1000,
  "Orb of Dominance": 1000,
  "Orb of Remembrance": 1000,
  "Orb of Unravelling": 1000,
  "Orb of Intention": 1000,

  // --- Tainted (Hellscape) currency ---
  "Tainted Chromatic Orb": 75,
  "Tainted Jeweller's Orb": 75,
  "Tainted Armourer's Scrap": 75,
  "Tainted Blacksmith's Whetstone": 100,
  "Tainted Orb of Fusing": 150,
  "Tainted Mythic Orb": 200,
  "Tainted Chaos Orb": 375,
  "Tainted Exalted Orb": 575,
  "Tainted Divine Teardrop": 900,
  "Volatile Vaal Orb": 900,
  "Tainted Catalyst": 150, // from the PoE wiki (poedb's page didn't cover Catalysts at all)
  "Tainted Oil": 500, // from the PoE wiki (poedb's page didn't cover Oils at all)

  // --- Maven's Chisels ---
  "Maven's Chisel of Avarice": 200,
  "Maven's Chisel of Divination": 200,
  "Maven's Chisel of Procurement": 200,
  "Maven's Chisel of Proliferation": 200,
  "Maven's Chisel of Scarabs": 200,

  // --- Memories (the plain-currency "Memory of X" line - distinct from the "Echo of X" boss-key
  // fragments under MapFragments/AtlasMemory, which poedb's page didn't cover; see the header note) ---
  "Memory of Loneliness": 1000,
  "Memory of Reverence": 1000,
  "Memory of Trauma": 1000,

  // --- Breach (Foulborn currency) - poedb confirms this exact assignment, resolving what used to
  // be an inferred rarity-ordering guess against the wiki's unassigned 500/750/1000 trio ---
  "Foulborn Orb of Augmentation": 500,
  "Foulborn Regal Orb": 750,
  "Foulborn Exalted Orb": 1000,
  "Flesh of Xesht": 1000,

  // --- Fragments with a single flat value (PoE wiki - poedb's page didn't reach the Fragments
  // section before its content was truncated) ---
  "An Audience With The King": 250,
  Simulacrum: 250,
  "Syndicate Medallion": 250,
  "Sacred Blossom": 250,
  "Ritual Vessel": 250,
  "The Maven's Writ": 1000,
  "Hivebrain Gland": 500,
  "Fragment of the Chimera": 250,
  "Fragment of the Hydra": 250,
  "Fragment of the Minotaur": 250,
  "Fragment of the Phoenix": 250,
  "Fragment of Constriction": 250,
  "Fragment of Enslavement": 250,
  "Fragment of Eradication": 250,
  "Fragment of Purification": 250,
  "Al-Hezmin's Crest": 250,
  "Baran's Crest": 250,
  "Drox's Crest": 250,
  "Veritania's Crest": 250,
  "Fragment of Emptiness": 500,
  "Fragment of Knowledge": 500,
  "Fragment of Shape": 500,
  "Fragment of Terror": 500,
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
  // NOTE: "Memory lines" on the wiki is now resolved to the "Memory of X" items above via poedb.
  // "Echo of X" (MapFragments/AtlasMemory/..Key - a distinct boss-access-key item) is still
  // unmapped: neither source names it, so guessing would risk mispricing it. Left with no gold data.
};

/** Eldritch ichor/ember tiers (35, 50, 75, 200 ascending) - same across both item families. */
const ELDRITCH_TIERS: Readonly<Record<string, number>> = {
  Lesser: 35,
  Greater: 50,
  Grand: 75,
  Exceptional: 200,
};

/** Delve resonators, by the tier word in the name (5, 10, 15, 25 ascending) - same across both
 *  Chaotic and Alchemical resonators. */
const RESONATOR_TIERS: Readonly<Record<string, number>> = {
  Primitive: 5,
  Potent: 10,
  Powerful: 15,
  Prime: 25,
};

/**
 * Essence tier prefix -> gold cost, uniform across every one of the 69 essence names
 * (Whispering/Muttering/.../Deafening Essence of <mod>) and confirmed identical across all 20
 * essence-of-<mod> families on poedb's page - so this single lookup covers the entire category
 * exactly, rather than needing 69 individual entries.
 */
const ESSENCE_TIER_COSTS: Readonly<Record<string, number>> = {
  Whispering: 25,
  Muttering: 35,
  Weeping: 45,
  Wailing: 55,
  Screaming: 65,
  Shrieking: 75,
  Deafening: 75,
};

/** The five "special" league-mechanic essences (Essence of Hysteria/Insanity/Horror/Delirium/
 *  Desolation), which don't follow the tiered-prefix naming above - flat 75 each per poedb. */
const SPECIAL_ESSENCE_COST = 75;

/** Every Delve fossil name (all 25) against its exact poedb cost - grouped by cost, not tier name,
 *  since fossil tiers aren't named the way essence/resonator tiers are. */
const FOSSIL_COSTS: Readonly<Record<string, number>> = Object.fromEntries(
  [
    [30, ["Scorched", "Frigid", "Metallic", "Jagged", "Aberrant", "Pristine", "Dense"]],
    [
      45,
      [
        "Corroded",
        "Prismatic",
        "Aetheric",
        "Serrated",
        "Bound",
        "Opulent",
        "Deft",
        "Lucent",
        "Shuddering",
        "Fundamental",
      ],
    ],
    [100, ["Sanctified", "Gilded", "Faceted", "Bloodstained", "Hollow", "Fractured", "Glyphic", "Tangled"]],
  ].flatMap(([cost, names]) => (names as string[]).map((n) => [`${n} Fossil`, cost as number]))
);

/**
 * Every real Scarab name (see docs/faustus-mapping.md's 115-entry Scarabs section) against its
 * exact poedb cost. poedb's own page lists a handful of scarab names that don't match any real,
 * currently-tradeable scarab (leftover/removed variants) - those are simply omitted here rather
 * than included as dead entries, since goldCostFor only ever looks this map up by a real name.
 */
const SCARAB_COSTS: Readonly<Record<string, number>> = {
  "Abyss Scarab": 75,
  "Abyss Scarab of Crystals": 125,
  "Abyss Scarab of Descending": 125,
  "Abyss Scarab of Multitudes": 100,
  "Abyss Scarab of the Consort": 350,
  "Ambush Scarab": 75,
  "Ambush Scarab of Containment": 350,
  "Ambush Scarab of Discernment": 125,
  "Ambush Scarab of Hidden Compartments": 100,
  "Ambush Scarab of Potency": 100,
  "Anarchy Scarab": 75,
  "Anarchy Scarab of Gigantification": 100,
  "Anarchy Scarab of Partnership": 125,
  "Anarchy Scarab of the Exceptional": 350,
  "Bestiary Scarab": 75,
  "Bestiary Scarab of Duplicating": 125,
  "Bestiary Scarab of the Herd": 100,
  "Betrayal Scarab": 75,
  "Betrayal Scarab of Reinforcements": 100,
  "Betrayal Scarab of the Allflame": 100,
  "Betrayal Scarab of Unbreaking": 125,
  "Beyond Scarab": 75,
  "Beyond Scarab of Haemophilia": 125,
  "Beyond Scarab of Resurgence": 125,
  "Beyond Scarab of the Invasion": 125,
  "Blight Scarab": 75,
  "Blight Scarab of Blooming": 350,
  "Blight Scarab of Invigoration": 350,
  "Blight Scarab of the Blightheart": 125,
  "Breach Scarab of Instability": 125,
  "Breach Scarab of Resonant Cascade": 350,
  "Breach Scarab of the Hive": 75,
  "Breach Scarab of the Incensed Swarm": 350,
  "Breach Scarab of the Marshal": 100,
  "Cartography Scarab of Corruption": 125,
  "Cartography Scarab of Escalation": 75,
  "Cartography Scarab of Risk": 100,
  "Cartography Scarab of the Multitude": 100,
  "Delirium Scarab": 75,
  "Delirium Scarab of Delusions": 125,
  "Delirium Scarab of Mania": 100,
  "Delirium Scarab of Neuroses": 125,
  "Delirium Scarab of Paranoia": 100,
  "Divination Scarab of Pilfering": 125,
  "Divination Scarab of Plenty": 125,
  "Divination Scarab of The Cloister": 75,
  "Domination Scarab": 75,
  "Domination Scarab of Apparitions": 100,
  "Domination Scarab of Evolution": 125,
  "Domination Scarab of Terrors": 350,
  "Essence Scarab": 75,
  "Essence Scarab of Adaptation": 350,
  "Essence Scarab of Ascent": 125,
  "Essence Scarab of Calcification": 350,
  "Essence Scarab of Stability": 100,
  "Expedition Scarab": 75,
  "Expedition Scarab of Archaeology": 125,
  "Expedition Scarab of Infusion": 350,
  "Expedition Scarab of Runefinding": 100,
  "Expedition Scarab of Verisium Powder": 100,
  "Harvest Scarab": 75,
  "Harvest Scarab of Cornucopia": 350,
  "Harvest Scarab of Doubling": 125,
  "Horned Scarab of Awakening": 350,
  "Horned Scarab of Bloodlines": 500,
  "Horned Scarab of Glittering": 350,
  "Horned Scarab of Nemeses": 125,
  "Horned Scarab of Pandemonium": 350,
  "Horned Scarab of Preservation": 500,
  "Horned Scarab of Tradition": 350,
  "Incursion Scarab": 75,
  "Incursion Scarab of Champions": 125,
  "Incursion Scarab of Invasion": 100,
  "Incursion Scarab of Timelines": 350,
  "Influencing Scarab of Hordes": 100,
  "Influencing Scarab of Interference": 125,
  "Influencing Scarab of the Elder": 75,
  "Influencing Scarab of the Shaper": 75,
  "Kalguuran Scarab": 100,
  "Kalguuran Scarab of Enriching": 350,
  "Kalguuran Scarab of Guarded Riches": 125,
  "Kalguuran Scarab of Refinement": 350,
  "Legion Scarab": 75,
  "Legion Scarab of Eternal Conflict": 350,
  "Legion Scarab of Officers": 125,
  "Legion Scarab of Treasures": 125,
  "Ritual Scarab of Abundance": 125,
  "Ritual Scarab of Corpses": 350,
  "Ritual Scarab of Selectiveness": 75,
  "Ritual Scarab of Wisps": 100,
  "Scarab of Adversaries": 75,
  "Scarab of Divinity": 100,
  "Scarab of Monstrous Lineage": 75,
  "Scarab of Radiant Storms": 350,
  "Scarab of Stability": 125,
  "Scarab of the Dextral": 125,
  "Scarab of the Sinistral": 125,
  "Scarab of Wisps": 125,
  "Sulphite Scarab": 75,
  "Sulphite Scarab of Fumes": 125,
  "Titanic Scarab": 75,
  "Titanic Scarab of Legend": 350,
  "Titanic Scarab of Treasures": 125,
  "Torment Scarab": 75,
  "Torment Scarab of Peculiarity": 100,
  "Torment Scarab of Possession": 125,
  "Trarthan Scarab": 75,
  "Trarthan Scarab of Infamy": 100,
  "Trarthan Scarab of Renown": 125,
  "Trarthan Scarab of Surprising Alliances": 350,
  "Ultimatum Scarab": 75,
  "Ultimatum Scarab of Bribing": 100,
  "Ultimatum Scarab of Catalysing": 500,
  "Ultimatum Scarab of Dueling": 350,
  "Ultimatum Scarab of Inscription": 125,
};

/**
 * Divination Card name -> exact poedb cost. Covers the majority of cards poedb's page listed
 * before its content was truncated (its Jewellery/Jewels category cut off partway through); any
 * card not in this map falls back to the wiki's 15-1850 family range, flagged approximate.
 */
const DIVINATION_CARD_COSTS: Readonly<Record<string, number>> = {
  "A Dab of Ink": 250,
  "Akil's Prophecy": 400,
  "Alivia's Grace": 175,
  "Anarchy's Price": 1250,
  "A Note in the Wind": 350,
  "Assassin's Favour": 65,
  "Assassin's Gift": 1850,
  "Astral Protection": 250,
  "Atziri's Arsenal": 200,
  Audacity: 525,
  "Beauty Through Death": 825,
  "Bowyer's Dream": 425,
  "Broken Truce": 175,
  "Cursed Words": 125,
  "Dark Dreams": 500,
  "Dark Temptation": 65,
  Death: 200,
  "Desperate Crusade": 375,
  "Destined to Crumble": 15,
  "Draped in Dreams": 625,
  Duality: 1150,
  "Emperor of Purity": 150,
  "Endless Night": 275,
  "Energy Sword": 500,
  "Etched in Blood": 700,
  "Forbidden Power": 150,
  "From Bone to Ashes": 400,
  "Further Invention": 850,
  "Gift of Asenath": 450,
  Humility: 150,
  "Hunter's Resolve": 75,
  "Immortal Resolve": 225,
  "Imperial Legacy": 55,
  "Judging Voices": 400,
  "Keeper's Corruption": 925,
  "Last Stand": 1150,
  "Lethean Temptation": 475,
  "Light and Truth": 250,
  "Lucky Bastion": 850,
  "Merciless Armament": 350,
  "Might is Right": 150,
  "Misery in Darkness": 450,
  Mitts: 10,
  "Nook's Crown": 925,
  "Poisoned Faith": 550,
  "Pride Before the Fall": 450,
  "Pride of the First Ones": 500,
  "Prometheus' Armoury": 800,
  Rats: 40,
  Rebirth: 475,
  "Reckless Ambition": 275,
  "Sambodhi's Wisdom": 575,
  "The Adventuring Spirit": 75,
  "The Archmage's Right Hand": 150,
  "The Army of Blood": 75,
  "The Astromancer": 1450,
  "The Avenger": 375,
  "The Battle Born": 120,
  "The Bear Woman": 225,
  "The Beast": 175,
  "The Betrayal": 150,
  "The Blazing Fire": 55,
  "The Body": 125,
  "The Brawny Battle Mage": 375,
  "The Carrion Crow": 25,
  "The Catch": 925,
  "The Celestial Justicar": 225,
  "The Chains that Bind": 70,
  "The Chosen": 1250,
  "The Coming Storm": 150,
  "The Conduit": 250,
  "The Dapper Prodigy": 150,
  "The Darkest Dream": 325,
  "The Dark Mage": 200,
  "The Deep Ones": 400,
  "The Demoness": 65,
  "The Endless Darkness": 925,
  "The Enforcer": 1100,
  "The Enthusiasts": 300,
  "The Escape": 250,
  "The Ethereal": 250,
  "The Fathomless Depths": 175,
  "The Fletcher": 150,
  "The Flora's Gift": 25,
  "The Formless Sea": 275,
  "The Fox in the Brambles": 225,
  "The Gentleman": 200,
  "The Gladiator": 120,
  "The Golden Era": 175,
  "The Greatest Intentions": 1350,
  "The Harvester": 40,
  "The Hermit": 35,
  "The Hive of Knowledge": 800,
  "The Incantation": 200,
  "The Inoculated": 105,
  "The Insane Cat": 1850,
  "The Insatiable": 175,
  "The Jester": 275,
  "The Jeweller's Boon": 125,
  "The Journalist": 55,
  "The King's Blade": 15,
  "The King's Heart": 275,
  "The Last One Standing": 850,
  "The Last Supper": 1025,
  "The Lich": 125,
  "The Long Watch": 550,
  "The Lord of Celebration": 225,
  "The Lunaris Priestess": 90,
  "The Mercenary": 175,
  "The Oath": 175,
  "The Offering": 275,
  "The Old Man": 1600,
  "The Pack Leader": 175,
  "The Pact": 300,
  "The Poet": 150,
  "The Porcupine": 125,
  "The Price of Loyalty": 1600,
  "The Queen": 400,
  "The Rabid Rhoa": 125,
  "The Road to Power": 350,
  "The Sacrifice": 650,
  "The Scarred Meadow": 35,
  "The Scavenger": 150,
  "The Shepherd's Sandals": 350,
  "The Shieldbearer": 925,
  "The Siren": 250,
  "The Soul": 900,
  "The Spoiled Prince": 225,
  "The Stormcaller": 110,
  "The Sun": 60,
  "The Throne": 400,
  "The Tower": 100,
  "The Traitor": 200,
  "The Twins": 125,
  "The Tyrant": 275,
  "The Undisputed": 825,
  "The Vast": 1200,
  "The Visionary": 75,
  "The Warlord": 250,
  "The Watcher": 125,
  "The Web": 95,
  "The Wedding Gift": 550,
  "The White Knight": 650,
  "The Whiteout": 275,
  "The Wind": 275,
  "The Wolf's Shadow": 125,
  "The Wolven King's Bite": 275,
  "The Wolverine": 200,
  "The World Eater": 925,
  "Thunderous Skies": 65,
  "Toxic Tidings": 375,
  Tranquillity: 950,
  Unchained: 275,
  Vanity: 225,
  "Vile Power": 175,
  "Who Asked": 1000,
  "A Familiar Call": 1150,
  "A Modest Request": 475,
  "A Mother's Parting Gift": 200,
  Apocalypse: 700,
  "A Stone Perfected": 425,
  "Azyran's Reward": 300,
  Bijoux: 350,
  "Blind Venture": 150,
  "Broken Promises": 650,
  "Brotherhood in Exile": 375,
  "Burning Blood": 1050,
  "Call to the First Ones": 175,
  "Choking Guilt": 1450,
  "Deadly Joy": 725,
  "Divine Justice": 1850,
  "Dying Light": 650,
  "Father's Love": 1350,
  "Fire Of Unknown Origin": 925,
  Friendship: 550,
  "Glimmer of Hope": 65,
  Heterochromia: 175,
  Hope: 150,
  Hubris: 120,
  "Hunter's Reward": 325,
  "Imperfect Memories": 650,
  "Lachrymal Necrosis": 250,
  "Lantador's Lost Love": 35,
  "Lonely Warrior": 1250,
  "Love Through Ice": 1350,
  "Luminous Trove": 575,
  "Lysah's Respite": 150,
  Matryoshka: 600,
  "Mawr Blaidd": 350,
  "One Last Score": 1000,
  "Peaceful Moments": 350,
  Perfection: 650,
  Prosperity: 55,
  "Reflection of the Heart": 670,
  Remembrance: 650,
  "Shard of Fate": 125,
  "Silence and Frost": 625,
};

const DIVINATION_CARD_ID_PREFIX = "Metadata/Items/DivinationCards/";

/**
 * Cost for one exchange-tradeable item by display name, or undefined when neither source covers
 * it at all. Name-pattern rules only cover families where the tier is genuinely recoverable from
 * the name (Eldritch ichor/ember, resonators, essences); everything else either matches one of the
 * exact per-name tables above or falls back to a flagged family estimate - never a fabricated
 * per-item guess.
 *
 * `id` is the item's GGG metadata id (lib/faustus.ts's FAUSTUS_NAME_TO_ID value for this name) -
 * needed only to recognise Divination Cards, whose flavour-text names can't be matched by a pattern.
 * Optional so this stays testable/callable on a name alone for every other family.
 */
export function goldCostFor(name: string, id?: string): GoldCost | undefined {
  if (id?.startsWith(DIVINATION_CARD_ID_PREFIX)) {
    const cardCost = DIVINATION_CARD_COSTS[name];
    return cardCost !== undefined ? exact(cardCost) : approx(200, "Divination cards range 15-1850 gold per card");
  }

  const exactCost = EXACT_COSTS[name];
  if (exactCost !== undefined) return exact(exactCost);

  const scarabCost = SCARAB_COSTS[name];
  if (scarabCost !== undefined) return exact(scarabCost);

  const fossilCost = FOSSIL_COSTS[name];
  if (fossilCost !== undefined) return exact(fossilCost);

  if (/^(Lesser|Greater|Grand|Exceptional) Eldritch (Ichor|Ember)$/.test(name)) {
    return exact(ELDRITCH_TIERS[name.split(" ")[0]]);
  }
  if (/^(Primitive|Potent|Powerful|Prime) (Alchemical|Chaotic) Resonator$/.test(name)) {
    return exact(RESONATOR_TIERS[name.split(" ")[0]]);
  }
  const essenceTierCost = ESSENCE_TIER_COSTS[name.split(" ")[0]];
  if (essenceTierCost !== undefined && name.includes("Essence of ")) return exact(essenceTierCost);
  if (name.startsWith("Essence of ")) return exact(SPECIAL_ESSENCE_COST);

  // Everything below is the wiki-fallback range for a category poedb's page didn't cover at all.
  if (name.endsWith(" Catalyst")) return approx(38, "Catalysts are 25 or 50 gold");
  if (name.endsWith(" Oil")) return approx(75, "Oils range 25-125 gold");
  if (name.startsWith("Omen of ")) return approx(50, "Omens are 25, 50 or 125 gold");
  if (name.includes("Tattoo of")) return approx(50, "Tattoos are 25, 50 or 125 gold");
  if (name === "Delirium Orb" || name.endsWith(" Delirium Orb")) return approx(150, "Delirium orbs range 75-250 gold");
  if (name.includes("Runegraft")) return approx(500, "Runegrafts are 500 gold (angler is 5000)");
  if (/^Timeless \w+ Emblem$/.test(name)) return approx(350, "Legion emblems range 50-750 gold by tier");
  if (name.endsWith(" Astrolabe")) return exact(1000);

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
