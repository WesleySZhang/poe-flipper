/**
 * Links to an item's own page on poe.ninja's economy site, e.g.
 * https://poe.ninja/poe1/economy/allflame/divination-cards/the-nurse. Pure (no server-only), so both
 * the snapshot builder and any component can use it.
 *
 * Two things the URL needs: the site's category slug (a fixed map from the API's type name, read off
 * poe.ninja's own nav 2026-09-24) and the item's `detailsId`. For stash-scraped items poe.ninja returns
 * `detailsId` on each line (it folds in variant + base type, e.g. "mageblood-5-flasks-heavy-belt") and
 * it's stored in the price snapshot; for currency-style types it's simply the slugified name.
 */

// Types with no entry here (Prophecy, Seed, HelmetEnchant, Watchstone, UniqueIdol, KalguuranRune,
// Coffin) have no matching poe.ninja page that was found - no link is shown for those.
const CATEGORY_SLUGS: Record<string, string> = {
  Currency: "currency",
  Fragment: "fragments",
  DivinationCard: "divination-cards",
  Scarab: "scarabs",
  Essence: "essences",
  Fossil: "fossils",
  Oil: "oils",
  DeliriumOrb: "delirium-orbs",
  Omen: "omens",
  Resonator: "resonators",
  Runegraft: "runegrafts",
  Artifact: "artifacts",
  DjinnCoin: "djinn-coins",
  Tattoo: "tattoos",
  AllflameEmber: "allflame-embers",
  UniqueWeapon: "unique-weapons",
  UniqueArmour: "unique-armours",
  UniqueAccessory: "unique-accessories",
  UniqueFlask: "unique-flasks",
  UniqueJewel: "unique-jewels",
  UniqueMap: "unique-maps",
  UniqueRelic: "unique-relics",
  UniqueTincture: "unique-tinctures",
  SkillGem: "skill-gems",
  ImbuedGem: "imbued-gems",
  ClusterJewel: "cluster-jewels",
  Map: "maps",
  BlightedMap: "blighted-maps",
  BlightRavagedMap: "blight-ravaged-maps",
  ValdoMap: "valdo-maps",
  Incubator: "incubators",
  Vial: "vials",
  Invitation: "invitations",
  Memory: "memories",
  ShrineBelt: "shrine-belts",
  Wombgift: "wombgifts",
  Beast: "beasts",
  IncursionTemple: "temples",
  BaseType: "base-types",
};

const CURRENCY_STYLE_TYPES = new Set([
  "Currency", "Fragment", "DivinationCard", "Scarab", "Essence", "Fossil", "Oil", "DeliriumOrb", "Omen",
  "Resonator", "Runegraft", "Artifact", "DjinnCoin", "Tattoo", "AllflameEmber",
]);

/** "Atziri's Arsenal" -> "atziris-arsenal" - poe.ninja's detailsId for currency-style names. */
export function ninjaSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Undefined when there's no known poe.ninja page for this type, or (for a stash item) no detailsId yet. */
export function ninjaItemUrl(league: string, type: string, name: string, detailsId?: string): string | undefined {
  const category = CATEGORY_SLUGS[type];
  if (!category) return undefined;
  const id = detailsId ?? (CURRENCY_STYLE_TYPES.has(type) ? ninjaSlug(name) : undefined);
  if (!id) return undefined;
  return `https://poe.ninja/poe1/economy/${league.toLowerCase()}/${category}/${id}`;
}
