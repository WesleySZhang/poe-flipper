import "server-only";
import type { LegacyStashItem } from "./poe-legacy-client";

export interface NetWorthBreakdownEntry {
  name: string;
  quantity: number;
  unitChaosValue: number;
  totalChaosValue: number;
}

export interface NetWorthResult {
  totalChaos: number;
  totalDivine: number;
  breakdown: NetWorthBreakdownEntry[];
}

function getDisplayName(item: LegacyStashItem): string {
  return item.name?.trim() || item.typeLine;
}

/** Prices unpriced/unmatched items at 0 chaos rather than guessing - keeps totals conservative. */
export function computeNetWorth(
  items: LegacyStashItem[],
  currencyPrices: Map<string, number>,
  itemPrices: Map<string, number>
): NetWorthResult {
  const breakdownMap = new Map<string, NetWorthBreakdownEntry>();

  for (const item of items) {
    const name = getDisplayName(item);
    const quantity = item.stackSize ?? 1;
    const unitChaosValue = currencyPrices.get(name) ?? itemPrices.get(name) ?? 0;
    if (unitChaosValue <= 0) continue;

    const existing = breakdownMap.get(name);
    if (existing) {
      existing.quantity += quantity;
      existing.totalChaosValue += quantity * unitChaosValue;
    } else {
      breakdownMap.set(name, {
        name,
        quantity,
        unitChaosValue,
        totalChaosValue: quantity * unitChaosValue,
      });
    }
  }

  const breakdown = Array.from(breakdownMap.values()).sort((a, b) => b.totalChaosValue - a.totalChaosValue);
  const totalChaos = breakdown.reduce((sum, entry) => sum + entry.totalChaosValue, 0);
  const divineChaosValue = currencyPrices.get("Divine Orb") ?? 0;
  const totalDivine = divineChaosValue > 0 ? totalChaos / divineChaosValue : 0;

  return { totalChaos, totalDivine, breakdown };
}
