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
  large,
}: {
  hidden: Set<ConfidenceTier>;
  onToggle: (tier: ConfidenceTier) => void;
  className?: string;
  /** Bigger circles for a touch target (the mobile filter row) - the table header keeps the compact size. */
  large?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {TIERS.map((tier) => {
        const isHidden = hidden.has(tier);
        return (
          <Badge
            key={tier}
            variant={isHidden ? "outline" : "default"}
            role="button"
            tabIndex={0}
            title={`${TIER_NAME[tier]} confidence - click to ${isHidden ? "show" : "hide"}`}
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
            className="shrink-0 cursor-pointer select-none justify-center p-0 text-xs"
            // Inline, not Tailwind classes, for the actual circle geometry - the base Badge's own
            // w-fit/rounded-4xl kept winning out over size-*/rounded-full despite those correctly
            // overriding it in the merged class *string*, so this guarantees the shape rather than
            // depending on class merge/specificity ordering.
            style={{ width: large ? "2rem" : "1.5rem", height: large ? "2rem" : "1.5rem", borderRadius: "9999px" }}
          >
            {TIER_LETTER[tier]}
          </Badge>
        );
      })}
    </div>
  );
}
