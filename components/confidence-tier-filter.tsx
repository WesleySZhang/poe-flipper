"use client";

import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import type { ConfidenceTier } from "@/lib/confidence";

const TIERS: ConfidenceTier[] = ["high", "medium", "low"];
// Single-letter to stay compact enough for a table header cell - the full name is still available
// via the title attribute below.
const TIER_LETTER: Record<ConfidenceTier, string> = { high: "H", medium: "M", low: "L" };
const TIER_NAME: Record<ConfidenceTier, string> = { high: "High", medium: "Medium", low: "Low" };

/**
 * Toggle-badge filter for the Confidence column - lives inside that column's own header, centered
 * under the "Confidence" label, so no label of its own is needed. Matches the same Badge-as-checkbox
 * pattern category-filter.tsx uses - a tier starts shown (selected/"default" variant) and clicking
 * it hides that tier, rather than the more common "click to select" sense.
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
    <div className={cn("flex items-center gap-1.5", className)}>
      {TIERS.map((tier) => (
        <Badge
          key={tier}
          variant={hidden.has(tier) ? "outline" : "default"}
          role="button"
          tabIndex={0}
          title={`${TIER_NAME[tier]} confidence - click to ${hidden.has(tier) ? "show" : "hide"}`}
          onClick={(e) => {
            // This sits inside the Confidence column's own header cell - stop the click from
            // bubbling any further than the badge itself.
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
          className="size-6 shrink-0 cursor-pointer select-none justify-center rounded-full p-0 text-xs"
        >
          {TIER_LETTER[tier]}
        </Badge>
      ))}
    </div>
  );
}
