"use client";

import Link from "next/link";
import { cn } from "cn";
import { PriceHistoryChart } from "@/components/price-history-chart";
import { useItemHistoryExpand } from "@/components/item-history-row";
import { itemPriceKey } from "@/lib/poe-ninja";
import type { PriceUnit } from "@/lib/price-unit";

export interface ItemHistoryCardField {
  label: string;
  value: React.ReactNode;
  /** Slightly bolder than a plain field - for Confidence and Change (Change via `rightFields`
   *  below). Same text size as a plain field, just heavier weight - not a bigger, visually
   *  detached figure. */
  emphasized?: boolean;
}

interface ItemHistoryCardProps {
  displayName: string;
  category: "currency" | "item";
  historyName: string;
  variant?: string;
  currentDay: number;
  targetDay?: number;
  currentValue?: number;
  predictedValue?: number;
  fetchPredictedCurve?: boolean;
  priceUnit: PriceUnit;
  /** Everything besides Current/Predicted/Change (Confidence, Category, Exchange) - rendered as a
   *  wrapping row of label/value chips on the left, in display order. */
  fields: ItemHistoryCardField[];
  /** Current, Predicted, Change, in that exact order - pinned to the far right of the same row as
   *  `fields`, since these three are the "here's the trade" figures a trader scans first. */
  rightFields: ItemHistoryCardField[];
}

/**
 * Mobile equivalent of ItemHistoryRow - a stacked card instead of a table row, so narrow screens
 * show the same information (item name + every column's value) without the horizontal scrolling a
 * many-column <table> forces at phone width. Tapping the card expands the same PriceHistoryChart
 * inline below it; the chart itself already scales to its container's width via a viewBox (see
 * price-history-chart.tsx's CHART_ASPECT_RATIO), so Today/Target stay visible with no side-scroll
 * of their own once expanded.
 */
export function ItemHistoryCard({
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
  fields,
  rightFields,
}: ItemHistoryCardProps) {
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
    <div className="overflow-hidden rounded-lg border border-border">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={handleKeyDown}
        className={cn("flex cursor-pointer flex-col gap-1.5 p-2 active:bg-muted/50", expanded && "bg-muted/50")}
      >
        {/* A real link to the full per-item detail page - see ItemHistoryRow's identical comment
            for why this is separate from the card's own click-to-expand (stopPropagation below). */}
        <Link
          href={`/item/${category}/${encodeURIComponent(itemPriceKey(historyName, variant))}`}
          onClick={(e) => e.stopPropagation()}
          className="block truncate text-sm font-medium text-primary hover:underline"
          title={displayName}
        >
          {displayName}
        </Link>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1.5">
            {fields.map((f, i) => (
              <div key={i} className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{f.label}</span>
                <span className={cn(f.emphasized ? "text-sm font-semibold" : "text-xs text-muted-foreground")}>
                  {f.value}
                </span>
              </div>
            ))}
          </div>
          <div className="flex shrink-0 gap-3">
            {rightFields.map((f, i) => (
              <div key={i} className="flex flex-col items-end">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{f.label}</span>
                <span className={cn(f.emphasized ? "text-sm font-bold" : "text-sm font-semibold")}>{f.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Same grid-template-rows 0fr<->1fr expand animation as ItemHistoryRow's chart row - see its
          own comment for why this needs to always be mounted rather than gated on hasExpandedOnce. */}
      <div
        className="grid border-t border-border"
        style={{
          gridTemplateRows: expanded ? "1fr" : "0fr",
          borderTopWidth: expanded ? undefined : 0,
          transition: "grid-template-rows 250ms ease, border-top-width 250ms ease",
        }}
      >
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
    </div>
  );
}
