"use client";

import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import type { ConfidenceTier } from "@/lib/confidence";

const TIERS: ConfidenceTier[] = ["high", "medium", "low"];
const TIER_LABEL: Record<ConfidenceTier, string> = { high: "High", medium: "Medium", low: "Low" };

/**
 * Toggle-badge filter for the Confidence column - lives inside that column's own header (see
 * SortableHeader's `extra` prop), so no label of its own; the "Confidence" sort label right above it
 * already says what these filter. Matches the same Badge-as-checkbox pattern category-filter.tsx
 * uses - a tier starts shown (selected/"default" variant) and clicking it hides that tier, rather
 * than the more common "click to select" sense, so the default (nothing clicked) shows everything,
 * same as the category filter starting fully selected.
 */
export function ConfidenceTierFilter({
  hidden,
  onToggle,
  className,
}: {
  hidden: Set<ConfidenceTier>;
  onToggle: (tier: ConfidenceTier) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {TIERS.map((tier) => (
        <Badge
          key={tier}
          variant={hidden.has(tier) ? "outline" : "default"}
          role="button"
          tabIndex={0}
          onClick={(e) => {
            // This sits inside SortableHeader's cell, right below its sort button - stop the click
            // from also bubbling up into that button and flipping the sort.
            e.stopPropagation();
            onToggle(tier);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onToggle(tier);
            }
          }}
          className="cursor-pointer select-none text-[0.65rem]"
        >
          {TIER_LABEL[tier]}
        </Badge>
      ))}
    </div>
  );
}
