/**
 * Thaumaturgic Dust from disenchanting a unique in Kingsmarch:
 *   dust = value × 100 × (20 − (84 − clamp(ilvl, 65, 84))) × (1 + 2% × quality)
 * `value` is the unique's base value (lib/disenchant-values.ts); the item-level part is poedb's
 * formula. Item level scales it ×1 at 65 and below up to ×20 at 84 and above - the same factor for
 * every unique, so it changes how much dust each gives but never which unique is the best dust per
 * chaos.
 *
 * Every item is assumed to be at 0% quality (unqualified, as most disenchant fodder actually is).
 * Quality would count +2% dust per point, as the in-game description says (poedb's formula uses
 * +1%) - see DUST_ASSUMED_QUALITY. Two open questions are in TODO.md: that quality rate, and
 * whether the ×2000 item-level-84 multiplier is right, since another formula in circulation gives
 * 1.25× more from item level 68 up. Pure, so components can import it.
 */
export const DUST_MIN_ITEM_LEVEL = 65;
export const DUST_MAX_ITEM_LEVEL = 84;
export const DUST_ASSUMED_QUALITY = 0;
const DUST_PERCENT_PER_QUALITY = 2;

export function dustItemLevelMultiplier(itemLevel: number): number {
  const clamped = Math.min(DUST_MAX_ITEM_LEVEL, Math.max(DUST_MIN_ITEM_LEVEL, itemLevel));
  return 20 - (DUST_MAX_ITEM_LEVEL - clamped);
}

export function dustFor(value: number, itemLevel: number): number {
  const qualityMultiplier = 1 + (DUST_PERCENT_PER_QUALITY * DUST_ASSUMED_QUALITY) / 100;
  return value * 100 * dustItemLevelMultiplier(itemLevel) * qualityMultiplier;
}
