import { cn } from "cn";
import { LEG_LABEL, type LegSource } from "@/lib/exchange-route";

/** Hover text for which market a flip leg trades on. */
export function legTitle(source: LegSource, divineChaosRate?: number): string {
  if (source === "chaos") return "Traded for Chaos Orbs on the Currency Exchange";
  if (source === "divine") {
    const rate = divineChaosRate ? `, valued at ${Math.round(divineChaosRate)}c each` : "";
    return `Traded for Divine Orbs on the Currency Exchange${rate}`;
  }
  return "No exchange market this hour - poe.ninja's price";
}

/**
 * A flip leg's price with the market it trades on underneath ("Chaos", "Divine" or "poe.ninja"), so
 * a route that buys with one currency and sells for the other reads at a glance. Used by the
 * Currency Exchange Flip and Divination Card Flips tables and the item detail page.
 */
export function LegPrice({
  value,
  source,
  divineChaosRate,
  align = "end",
}: {
  value: React.ReactNode;
  source: LegSource;
  divineChaosRate?: number;
  align?: "start" | "end";
}) {
  return (
    <span
      className={cn("inline-flex cursor-help flex-col leading-tight", align === "end" ? "items-end" : "items-start")}
      title={legTitle(source, divineChaosRate)}
    >
      <span>{value}</span>
      <span className="text-[10px] font-normal text-muted-foreground">{LEG_LABEL[source]}</span>
    </span>
  );
}
