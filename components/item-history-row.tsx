"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink } from "lucide-react";
import { cn } from "cn";
import { TableCell, TableRow } from "@/components/ui/table";
import { PriceHistoryChart, type PriceHistoryFetchState } from "@/components/price-history-chart";
import { activePrice, type PriceUnit } from "@/lib/price-unit";
import { itemPriceKey, poeWikiUrl } from "@/lib/poe-ninja";
import type { LeagueSeries } from "@/lib/price-history";
import type { PredictionCurvePoint } from "@/lib/flip-suggestions";

type CurveFetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; points: PredictionCurvePoint[] };

interface UseItemHistoryExpandArgs {
  category: "currency" | "item";
  /** Raw, pre-display-formatting name the price-history API keys on - see FlipSuggestion.historyName. */
  historyName: string;
  variant?: string;
  /** When true, also fetches this item's full day-1-30 predicted curve on expand (see
   *  app/api/flip-suggestion-curve/route.ts) so the chart draws a detailed forecast line instead of
   *  a single straight segment to targetDay - see PriceHistoryChart's predictedCurve prop. Only
   *  meaningful for a row that's pricing TODAY's real league day against TODAY's live prices (the
   *  curve endpoint always answers for "today"); the mirage simulator's replayed-history rows leave
   *  this unset and keep the plain two-point line. */
  fetchPredictedCurve?: boolean;
  priceUnit: PriceUnit;
}

/**
 * Owns the expand/fetch state for one item's price-history chart - split out of ItemHistoryRow so
 * both the desktop table row and the mobile card (components/item-history-card.tsx) can drive the
 * same chart from the same lazy-fetched data, without duplicating the fetch logic in two places.
 * One hook call per item, same reasoning as FaustusPriceButton: React hooks need a component
 * instance per row, not an inline call inside a .map() callback.
 */
export function useItemHistoryExpand({
  category,
  historyName,
  variant,
  fetchPredictedCurve,
  priceUnit,
}: UseItemHistoryExpandArgs) {
  const [expanded, setExpanded] = useState(false);
  // Sticks at true forever once expanded once - the chart stays mounted after that (see callers)
  // so collapsing can play a closing animation instead of vanishing instantly, and re-expanding
  // doesn't need a fresh "grow from nothing" transition every time.
  const [hasExpandedOnce, setHasExpandedOnce] = useState(false);
  const [state, setState] = useState<PriceHistoryFetchState | undefined>();
  const [curveState, setCurveState] = useState<CurveFetchState | undefined>();

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next) setHasExpandedOnce(true);
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

  return { expanded, hasExpandedOnce, state, predictedCurve, toggle };
}

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
 * league - see components/price-history-chart.tsx. Consolidates the Item-cell markup that used to
 * be duplicated identically in both flip-suggestions-panel.tsx and mirage-simulator-panel.tsx.
 * Desktop-table-only - components/item-history-card.tsx is the mobile-card equivalent, sharing the
 * same useItemHistoryExpand hook above.
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
  const { expanded, hasExpandedOnce, state, predictedCurve, toggle } = useItemHistoryExpand({
    category,
    historyName,
    variant,
    fetchPredictedCurve,
    priceUnit,
  });

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
          <div className="flex max-w-[140px] items-center gap-1 sm:max-w-[200px] lg:max-w-[280px]">
            {/* A real link to the full per-item detail page (app/item/[category]/[key]/page.tsx) -
                deliberately distinct from the row's own click-to-expand behavior below: clicking
                the name navigates away, clicking anywhere else on the row still just expands the
                inline chart. stopPropagation keeps the row's own onClick from ALSO firing on a
                name click. No flex-1/min-w-0 here - the link sizes to its own text (up to the
                truncation cap), not the full cell width, so clicking the empty space next to a
                short name falls through to the row's own click-to-expand instead of navigating. */}
            <Link
              href={`/item/${category}/${encodeURIComponent(itemPriceKey(historyName, variant))}`}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 truncate text-primary hover:overflow-x-auto hover:text-clip hover:underline focus:overflow-x-auto focus:text-clip"
              title={displayName}
            >
              {displayName}
            </Link>
            {/* poewiki.net (not Fandom - see poeWikiUrl's own comment) cross-reference, opened in a
                new tab so it never navigates away from the table; stopPropagation for the same
                reason as the name link above. */}
            <a
              href={poeWikiUrl(historyName)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="View on poewiki"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3" />
            </a>
            {/* Purely decorative - NOT wrapped in its own click handler, so tapping it (or the
                empty space around it) falls through to the row's own click-to-expand like any
                other non-text part of the cell. Flips to point up while expanded. */}
            <ChevronDown
              className="size-3.5 shrink-0 text-muted-foreground transition-transform"
              style={{ transform: expanded ? "rotate(180deg)" : undefined }}
            />
          </div>
        </TableCell>
        {children}
      </TableRow>
      {/* Always mounted (not gated on hasExpandedOnce) - a CSS transition needs the browser to have
          already painted the "before" state (grid-template-rows: 0fr) at least one frame before the
          "after" state, or there's nothing to interpolate from. Mounting this collapsed AND flipping
          it open in the very same render (which gating on hasExpandedOnce would do on a row's first
          expand) skips straight to the end state with no animation at all - confirmed by measuring
          the row's actual height mid-transition in a real browser. PriceHistoryChart itself still
          only mounts once hasExpandedOnce (below), so an unexpanded row costs just a couple of empty,
          zero-height divs, not a chart instance. */}
      <TableRow>
        {/* p-0 - the animated wrapper below owns its own padding, so the grid row can actually
            collapse to a true 0px (any padding left on the <td> itself would floor the collapsed
            height there instead). The grid-template-rows 0fr<->1fr trick animates a height that's
            otherwise "auto" (the chart's real height varies by content) without JS measuring it -
            a plain max-height transition would need a guessed-too-large fixed end value instead. */}
        <TableCell colSpan={colSpan} className="p-0">
          <div
            className="grid"
            style={{ gridTemplateRows: expanded ? "1fr" : "0fr", transition: "grid-template-rows 250ms ease" }}
          >
            {/* min-h-0 overrides a grid item's default min-height:auto, which would otherwise keep
                it (and so the row) at its content height regardless of the 0fr track size above. */}
            <div className="min-h-0 overflow-hidden">
              {hasExpandedOnce && (
                <div className="bg-muted/20 p-2">
                  <PriceHistoryChart
                    state={state ?? { status: "loading" }}
                    currentDay={currentDay}
                    targetDay={targetDay}
                    currentValue={currentValue}
                    predictedValue={predictedValue}
                    predictedCurve={predictedCurve}
                    priceUnit={priceUnit}
                  />
                </div>
              )}
            </div>
          </div>
        </TableCell>
      </TableRow>
    </>
  );
}
