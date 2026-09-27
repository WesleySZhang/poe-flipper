/**
 * Thaumaturgic Dust from disenchanting a unique in Kingsmarch, per poedb's formula:
 *   dust = value × 100 × (20 − (84 − clamp(ilvl, 65, 84))) × (1 + quality / 100)
 * `value` is the unique's base value (lib/disenchant-values.ts). Item level scales it ×1 at 65 and
 * below up to ×20 at 84 and above - the same factor for every unique, so it changes how much dust
 * each gives but never which unique is the best dust per chaos.
 *
 * Quality is left out: poedb's formula has +1% per point, the in-game description +2%, and it's
 * unchecked which is right (see the poe-disenchanting skill). Pure, so components can import it.
 */
export const DUST_MIN_ITEM_LEVEL = 65;
export const DUST_MAX_ITEM_LEVEL = 84;

export function dustItemLevelMultiplier(itemLevel: number): number {
  const clamped = Math.min(DUST_MAX_ITEM_LEVEL, Math.max(DUST_MIN_ITEM_LEVEL, itemLevel));
  return 20 - (DUST_MAX_ITEM_LEVEL - clamped);
}

export function dustFor(value: number, itemLevel: number): number {
  return value * 100 * dustItemLevelMultiplier(itemLevel);
}
