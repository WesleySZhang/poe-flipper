"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { PriceHistoryChart, type PriceHistoryFetchState } from "@/components/price-history-chart";
import type { PriceUnit } from "@/lib/price-unit";
import type { LeagueSeries } from "@/lib/price-history";

interface ItemHistoryRowProps {
  /** The name shown in the Item cell - already formatted with any variant suffix. */
  displayName: string;
  category: "currency" | "item";
  /** Raw, pre-display-formatting name the price-history API keys on - see FlipSuggestion.historyName. */
  historyName: string;
  variant?: string;
  currentDay: number;
  priceUnit: PriceUnit;
  /** Total column count of the table this row lives in, so the expanded chart row can span all of them. */
  colSpan: number;
  /** Every other <TableCell> in the summary row (Category, Current, Predicted, ...), unchanged. */
  children: React.ReactNode;
}

/**
 * Wraps a table row with a click-to-expand chart of the item's price history across every past
 * league - see components/price-history-chart.tsx. Owns its own expand/fetch state per row (one
 * component instance per row, same reasoning as FaustusPriceButton: React hooks need a component
 * instance per row, not an inline call inside a .map() callback), and consolidates the Item-cell
 * markup that used to be duplicated identically in both flip-suggestions-panel.tsx and
 * mirage-simulator-panel.tsx.
 */
export function ItemHistoryRow({
  displayName,
  category,
  historyName,
  variant,
  currentDay,
  priceUnit,
  colSpan,
  children,
}: ItemHistoryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<PriceHistoryFetchState | undefined>();

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    // Fetch once per row, on first expand - cached across collapse/re-expand like FaustusPriceButton
    // does, except a failed fetch is retried on the next expand rather than staying stuck on error.
    if (next && (state === undefined || state.status === "error")) {
      setState({ status: "loading" });
      const params = new URLSearchParams({ category, name: historyName });
      if (variant) params.set("variant", variant);
      fetch(`/api/price-history?${params}`)
        .then((res) => {
          if (!res.ok) throw new Error("price-history request failed");
          return res.json() as Promise<LeagueSeries[]>;
        })
        .then((series) => setState({ status: "loaded", series }))
        .catch(() => setState({ status: "error" }));
    }
  }

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? "Hide price history" : "Show price history"}
              onClick={toggle}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
            <div
              tabIndex={0}
              className="max-w-[140px] truncate hover:overflow-x-auto hover:text-clip focus:overflow-x-auto focus:text-clip sm:max-w-[200px] lg:max-w-[280px]"
              title={displayName}
            >
              {displayName}
            </div>
          </div>
        </TableCell>
        {children}
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={colSpan} className="bg-muted/20">
            <PriceHistoryChart state={state ?? { status: "loading" }} currentDay={currentDay} priceUnit={priceUnit} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
