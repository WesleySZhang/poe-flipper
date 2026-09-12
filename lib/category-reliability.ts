import { CURRENCY_OVERVIEW_TYPES, ITEM_OVERVIEW_TYPES } from "./poe-ninja";

// The full known category taxonomy (poe.ninja's currency + item type buckets), independent of
// whatever happens to be in a given fetch's results - a fresh/early league can have zero live
// listings for whole categories (e.g. niche crafting currencies before the market fills in), and
// deriving the filter's category list from the fetched rows alone would make the filter itself
// shrink along with it. Keeping it static means every category is always a visible, toggleable
// option even when it currently has nothing to show.
export const ALL_CATEGORIES: string[] = Array.from(new Set<string>([...CURRENCY_OVERVIEW_TYPES, ...ITEM_OVERVIEW_TYPES])).sort();

// poe.ninja's category identifiers are PascalCase with no spaces (e.g. "SkillGem") - insert a
// space at each lowercase-to-uppercase boundary for display purposes only; the raw identifier is
// still what's used as the filter key everywhere else.
export function humanizeCategoryName(category: string): string {
  return category.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

// Historical price data quality varies a lot by category - evergreen, heavily-traded currency
// buckets (fossils, essences, scarabs, delirium orbs, ...) tend to have dense, clean daily price
// history, while niche/derivative categories (unique variants, skill gems, base types, ...) have
// sparser, noisier data that produces less trustworthy growth ratios. This is a fixed, hand-curated
// list (not derived from the data itself) used only to pick sensible category-filter defaults in
// the UI - everything not listed here is treated as unreliable and starts unselected.
export const RELIABLE_CATEGORIES: ReadonlySet<string> = new Set([
  "Currency",
  "DeliriumOrb",
  "DivinationCard",
  "Essence",
  "Fossil",
  "Fragment",
  "Invitation",
  "Oil",
  "Omen",
  "Tattoo",
]);

export function isReliableCategory(category: string): boolean {
  return RELIABLE_CATEGORIES.has(category);
}

// Unique items and skill gems price around build/meta popularity rather than pure supply/demand
// fundamentals, and scarabs price around which league mechanics/strategies are popular that league
// - all three shift with the league's meta in a way the historical growth ratio can't see coming.
// Grouped together as their own tier between "reliable" and "unreliable" - shown in the UI as the
// "Meta items" group - so the UI can call that caveat out specifically instead of implying either
// "trust this" or "sparse data". Order matters here - it's the display order in the UI (Scarab,
// Unique Jewel and Unique Flask first, since they're enabled by default; see
// isDefaultEnabledCategory below).
export const UNIQUE_CATEGORIES_ORDERED: string[] = [
  "Scarab",
  "UniqueJewel",
  "UniqueFlask",
  "UniqueAccessory",
  "UniqueArmour",
  "UniqueTincture",
  "UniqueWeapon",
  "SkillGem",
];

const UNIQUE_CATEGORIES: ReadonlySet<string> = new Set(UNIQUE_CATEGORIES_ORDERED);

export function isUniqueCategory(category: string): boolean {
  return UNIQUE_CATEGORIES.has(category);
}

// Scarab, Unique Jewel and Unique Flask are enabled by default - the rest of the meta-items group
// starts off, same as the unreliable group.
const DEFAULT_ENABLED_UNIQUE_CATEGORIES: ReadonlySet<string> = new Set(["Scarab", "UniqueJewel", "UniqueFlask"]);

export function isDefaultEnabledCategory(category: string): boolean {
  return isReliableCategory(category) || DEFAULT_ENABLED_UNIQUE_CATEGORIES.has(category);
}
