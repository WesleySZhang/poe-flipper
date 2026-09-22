"use client";

import { useState } from "react";
import { cn } from "cn";
import { TableCell, TableRow } from "@/components/ui/table";
import { PriceHistoryChart, type PriceHistoryFetchState } from "@/components/price-history-chart";
import { activePrice, type PriceUnit } from "@/lib/price-unit";
import type { LeagueSeries } from "@/lib/price-history";
import type { PredictionCurvePoint } from "@/lib/flip-suggestions";

type CurveFetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; points: PredictionCurvePoint[] };

interface ItemHistoryRowProps {
  /** The name shown in the Item cell - already formatted with any variant suffix. */
  displayName: string;
  category: "currency" | "item";
  /** Raw, pre-display-formatting name the price-history API keys on - see FlipSuggestion.historyName. */
  historyName: string;
  variant?: string;
  currentDay: number;
  /** currentDay + the prediction's duration - see PriceHistoryChart's targetDay prop. */
  targetDay?: number;
  /** Already resolved to the active priceUnit - see PriceHistoryChart's matching props. Both (and
   *  targetDay) are required to draw the dashed "Predicted" line at all. */
  currentValue?: number;
  predictedValue?: number;
  /** When true, also fetches this item's full day-1-30 predicted curve on expand (see
   *  app/api/flip-suggestion-curve/route.ts) so the chart draws a detailed forecast line instead of
   *  a single straight segment to targetDay - see PriceHistoryChart's predictedCurve prop. Only
   *  meaningful for a row that's pricing TODAY's real league day against TODAY's live prices (the
   *  curve endpoint always answers for "today"); the mirage simulator's replayed-history rows leave
   *  this unset and keep the plain two-point line. */
  fetchPredictedCurve?: boolean;
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
  targetDay,
  currentValue,
  predictedValue,
  fetchPredictedCurve,
  priceUnit,
  colSpan,
  children,
}: ItemHistoryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<PriceHistoryFetchState | undefined>();
  const [curveState, setCurveState] = useState<CurveFetchState | undefined>();

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
    // Same lazy-fetch-once-cached-on-error-retry pattern as price-history above, just a separate
    // request/cache - the two are independent data sources that happen to land on the same chart.
    if (next && fetchPredictedCurve && (curveState === undefined || curveState.status === "error")) {
      setCurveState({ status: "loading" });
      const params = new URLSearchParams({ category, name: historyName });
      if (variant) params.set("variant", variant);
      fetch(`/api/flip-suggestion-curve?${params}`)
        .then((res) => {
          if (!res.ok) throw new Error("flip-suggestion-curve request failed");
          return res.json() as Promise<PredictionCurvePoint[]>;
        })
        .then((points) => setCurveState({ status: "loaded", points }))
        .catch(() => setCurveState({ status: "error" }));
    }
  }

  // Resolved to the active priceUnit here (not in PriceHistoryChart, which only ever draws numbers -
  // see its own currentValue/predictedValue doc) - a null chaos/divine value (the item wasn't
  // priceable/trend-matched at that specific duration, see lib/flip-suggestions.ts's
  // PredictionCurvePoint) becomes undefined, which the chart already knows to skip.
  const predictedCurve =
    curveState?.status === "loaded"
      ? curveState.points.map((p) => ({
          durationDays: p.durationDays,
          value:
            p.predictedChaosValue === null
              ? undefined
              : activePrice(p.predictedChaosValue, p.predictedDivineValue ?? undefined, priceUnit),
        }))
      : undefined;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  }

  return (
    <>
      {/* The whole row toggles the chart - tabIndex/onKeyDown make it keyboard-reachable
          (Enter/Space) without claiming role="button" on a <tr>, which would strip its table-row
          semantics for screen readers. */}
      <TableRow
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={handleKeyDown}
        className={cn("cursor-pointer", expanded && "bg-muted/50")}
      >
        <TableCell>
          <div
            tabIndex={0}
            className="max-w-[140px] truncate hover:overflow-x-auto hover:text-clip focus:overflow-x-auto focus:text-clip sm:max-w-[200px] lg:max-w-[280px]"
            title={displayName}
          >
            {displayName}
          </div>
        </TableCell>
        {children}
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={colSpan} className="bg-muted/20">
            <PriceHistoryChart
              state={state ?? { status: "loading" }}
              currentDay={currentDay}
              targetDay={targetDay}
              currentValue={currentValue}
              predictedValue={predictedValue}
              predictedCurve={predictedCurve}
              priceUnit={priceUnit}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
