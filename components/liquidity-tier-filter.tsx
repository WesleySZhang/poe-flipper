"use client";

import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import type { LiquidityTier } from "@/lib/liquidity";

const TIERS: LiquidityTier[] = ["high", "medium", "low"];
// Single-letter to stay compact enough for a table header cell - the full name is still available
// via the title attribute below.
const TIER_LETTER: Record<LiquidityTier, string> = { high: "H", medium: "M", low: "L" };
const TIER_NAME: Record<LiquidityTier, string> = { high: "High", medium: "Medium", low: "Low" };

/**
 * Toggle-badge filter for the Liquidity column - same Badge-as-checkbox pattern as
 * confidence-tier-filter.tsx (a tier starts shown and clicking it hides that tier), reused here
 * since Liquidity is the same kind of "heuristic tier over a raw number" the Confidence column
 * already uses this pattern for. Lives inside the Liquidity column's own header, which gives up its
 * sort button for this the same way the Confidence column does.
 */
export function LiquidityTierFilter({
  hidden,
  onToggle,
  className,
}: {
  hidden: Set<LiquidityTier>;
  onToggle: (tier: LiquidityTier) => void;
  className?: string;
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
            title={`${TIER_NAME[tier]} liquidity - click to ${isHidden ? "show" : "hide"}`}
            onClick={(e) => {
              // This sits inside the Liquidity column's own header cell - stop the click from
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
            // Inline, not Tailwind classes, for the actual circle geometry - see
            // confidence-tier-filter.tsx's identical comment on why.
            style={{ width: "1.5rem", height: "1.5rem", borderRadius: "9999px" }}
          >
            {TIER_LETTER[tier]}
          </Badge>
        );
      })}
    </div>
  );
}
