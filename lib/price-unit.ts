export type PriceUnit = "chaos" | "divine";

/**
 * Formats a price for table display in the selected unit. Chaos values on their own can be
 * misleading for expensive items - since they're really priced in Divine Orbs by traders, a chaos
 * price swings with the Divine Orb exchange rate (which inflates a lot over a league) as much as
 * with the item's own actual value. Divine amounts are usually much smaller than chaos ones, so
 * they get more decimal places to stay legible for cheaper items.
 */
export function formatPriceValue(chaosValue: number, divineValue: number | undefined, unit: PriceUnit): string {
  if (unit === "chaos") return chaosValue.toFixed(1);
  if (divineValue === undefined) return "—";
  return divineValue.toFixed(divineValue < 1 ? 3 : 2);
}

export function priceUnitLabel(unit: PriceUnit): string {
  return unit === "chaos" ? "c" : "div";
}
