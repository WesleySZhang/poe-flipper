export type PriceUnit = "chaos" | "divine";

/**
 * Bulk-flippable currency (Orb of Alteration, Armourer's Scrap, ...) can trade well under 0.01c -
 * a flat decimal count would round most of those straight to "0.0c", hiding the exact price that
 * bulk-flip math actually depends on. Scale precision to the value instead; wholeDecimals is how
 * many places to use once the value is >= 1 (differs between chaos and divine below).
 */
function decimalsFor(value: number, wholeDecimals: number): number {
  if (value < 0.01) return 4;
  if (value < 1) return 3;
  return wholeDecimals;
}

/**
 * Formats a price for table display in the selected unit. Chaos values on their own can be
 * misleading for expensive items - since they're really priced in Divine Orbs by traders, a chaos
 * price swings with the Divine Orb exchange rate (which inflates a lot over a league) as much as
 * with the item's own actual value. Divine amounts are usually much smaller than chaos ones, so
 * they get more decimal places to stay legible for cheaper items.
 */
export function formatPriceValue(chaosValue: number, divineValue: number | undefined, unit: PriceUnit): string {
  if (unit === "chaos") return `${chaosValue.toFixed(decimalsFor(chaosValue, 1))}c`;
  if (divineValue === undefined) return "—";
  return `${divineValue.toFixed(decimalsFor(divineValue, 2))}d`;
}

export function priceUnitLabel(unit: PriceUnit): string {
  return unit === "chaos" ? "c" : "div";
}

/**
 * The growth ratio for the selected unit. The divine one measures real value change (chaos
 * debasement divided out) and is undefined when too few leagues had a Divine Orb rate to average.
 */
export function activeRatio(chaosRatio: number, divineRatio: number | undefined, unit: PriceUnit): number | undefined {
  return unit === "chaos" ? chaosRatio : divineRatio;
}

/** The price for the selected unit - same undefined-for-divine caveat as activeRatio. Used for sorting a price column by whichever unit is currently displayed. */
export function activePrice(chaosValue: number, divineValue: number | undefined, unit: PriceUnit): number | undefined {
  return unit === "chaos" ? chaosValue : divineValue;
}

export function formatRatio(chaosRatio: number, divineRatio: number | undefined, unit: PriceUnit): string {
  const ratio = activeRatio(chaosRatio, divineRatio, unit);
  return ratio === undefined ? "—" : `${ratio.toFixed(2)}x`;
}

export function formatPercentChange(
  chaosRatio: number,
  divineRatio: number | undefined,
  unit: PriceUnit
): string {
  const ratio = activeRatio(chaosRatio, divineRatio, unit);
  return ratio === undefined ? "—" : `${Math.round((ratio - 1) * 100)}%`;
}
