import type { ListingMod, ListingPrice, SoldListingItem } from "./sold-tracker";

/**
 * An item as Path of Exile's own item text - what Ctrl+C copies in game and the trade site's
 * "Copy Item" gives (the fetch's `extended.text`) - rebuilt from what the sold listing tracker
 * stores, so it pastes into Path of Building, Craft of Exile and the trade site's search.
 *
 * Matches GGG's trade text line for line (checked against 14 real items, 2026-09-28), except that it:
 *  - marks mods "(implicit)", "(enchant)", "(crafted)", "(fractured)" like the in-game copy does -
 *    Path of Building needs "(implicit)" to tell implicits apart (checked with its own parser);
 *  - leaves out the flavour text and a jewel's "Place into an allocated Jewel Socket..." line (not
 *    stored; neither tool reads them);
 *  - always adds the price note (GGG only has one when the item carries its own note).
 * Section order, as the game writes it:
 *
 *   Item Class / Rarity / name / base type   (a magic item's base line is its full name)
 *   properties                               "Quality: +10% (augmented)", weapon stats, ...
 *   Requirements:                            "Level: 68", "Int: 194"
 *   Sockets: R-G B                           (with the game's trailing space)
 *   Item Level: 84
 *   enchants, then implicits, then explicits - one section each (fractured first, crafted last)
 *   Corrupted
 *   Shaper Item / Synthesised Item / Fractured Item / Mirrored / Foil Unique (Aureate)
 *   Note: ~b/o 100 divine
 *
 * Listings recorded before the item class was stored have no "Item Class" line (both tools read
 * the item without it).
 */
const SEPARATOR = "--------";
const EXPLICIT_KINDS = new Set<ListingMod["kind"]>(["fractured", "explicit", "crafted", "crucible", "scourge"]);
const INFLUENCES = new Set(["Shaper", "Elder", "Crusader", "Redeemer", "Hunter", "Warlord"]);
// Tags the game writes on their own line (after Corrupted), and how.
const TAG_LINES: Record<string, string> = {
  Synthesised: "Synthesised Item",
  Fractured: "Fractured Item",
  Mirrored: "Mirrored",
  Split: "Split",
};

// The in-game copy's markers. GGG's trade text leaves them out, but Path of Building needs
// "(implicit)" to tell implicits from explicits (checked with its parser, 2026-09-28).
const MOD_MARKERS: Partial<Record<ListingMod["kind"], string>> = {
  enchant: " (enchant)",
  implicit: " (implicit)",
  fractured: " (fractured)",
  crafted: " (crafted)",
};

function modLine(m: ListingMod): string {
  return m.text + (MOD_MARKERS[m.kind] ?? "");
}

export function itemGameText(item: SoldListingItem, price?: ListingPrice): string {
  const detail = item.detail;
  const mods: ListingMod[] =
    detail?.mods ??
    [...item.implicits.map((text) => ({ kind: "implicit" as const, text })), ...item.mods.map((text) => ({ kind: "explicit" as const, text }))];
  const tags = detail?.tags ?? [];

  const sections: string[][] = [
    [
      ...(detail?.itemClass ? [`Item Class: ${detail.itemClass}`] : []),
      `Rarity: ${item.rarity ?? "Normal"}`,
      ...(item.name ? [item.name] : []),
      item.typeLine,
    ],
    detail?.properties ?? [],
    detail?.requirements.length ? ["Requirements:", ...detail.requirements] : [],
    detail?.sockets ? [`Sockets: ${detail.sockets} `] : [],
    item.ilvl !== undefined ? [`Item Level: ${item.ilvl}`] : [],
    mods.filter((m) => m.kind === "enchant").map(modLine),
    mods.filter((m) => m.kind === "implicit").map(modLine),
    mods.filter((m) => EXPLICIT_KINDS.has(m.kind)).map(modLine),
    item.corrupted ? ["Corrupted"] : [],
    tags.filter((t) => INFLUENCES.has(t)).map((t) => `${t} Item`),
    ...tags.filter((t) => t in TAG_LINES).map((t) => [TAG_LINES[t]]),
    ...tags.filter((t) => t.startsWith("Foil: ")).map((t) => [`Foil Unique (${t.slice("Foil: ".length)})`]),
    price ? [`Note: ${price.type ?? "~b/o"} ${price.amount} ${price.currency}`] : [],
  ];
  return (
    sections
      .filter((s) => s.length > 0)
      .map((s) => s.join("\r\n"))
      .join(`\r\n${SEPARATOR}\r\n`) + "\r\n"
  );
}
