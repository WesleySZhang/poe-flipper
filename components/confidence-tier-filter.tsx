"use client";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import type { ConfidenceTier } from "@/lib/confidence";

const TIERS: ConfidenceTier[] = ["high", "medium", "low"];
const TIER_LABEL: Record<ConfidenceTier, string> = { high: "High", medium: "Medium", low: "Low" };

/**
 * Toggle-badge filter for the Confidence column, matching the same Badge-as-checkbox pattern
 * category-filter.tsx already uses - a tier starts shown (selected/"default" variant) and clicking
 * it hides that tier, rather than the more common "click to select" sense, so the default (nothing
 * clicked) shows everything, same as the category filter starting fully selected.
 */
export function ConfidenceTierFilter({
  hidden,
  onToggle,
}: {
  hidden: Set<ConfidenceTier>;
  onToggle: (tier: ConfidenceTier) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Confidence</Label>
      <div className="flex h-8 items-center gap-1.5">
        {TIERS.map((tier) => (
          <Badge
            key={tier}
            variant={hidden.has(tier) ? "outline" : "default"}
            role="button"
            tabIndex={0}
            onClick={() => onToggle(tier)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle(tier);
              }
            }}
            className="cursor-pointer select-none"
          >
            {TIER_LABEL[tier]}
          </Badge>
        ))}
      </div>
    </div>
  );
}
