"use client";

import { Badge } from "@/components/ui/badge";
import { confidenceTier, describeConfidence, formatConfidence } from "@/lib/confidence";

/** Badge variant per tier - reuses the variant-as-state vocabulary already used by the category
 *  filter's selected/unselected badges, rather than introducing green/amber, which appear nowhere
 *  in this app (red is reserved for warnings). */
const TIER_VARIANT = {
  high: "default",
  medium: "secondary",
  low: "outline",
} as const;

/**
 * How reliably a prediction's item has gained in past leagues - see lib/confidence.ts. Rendered as
 * a tier rather than a bare number because the score is a heuristic ranking, not a probability;
 * the exact number and what it's based on live in the hover text.
 */
export function ConfidenceBadge({
  score,
  upFraction,
  leagueCount,
}: {
  score: number | undefined;
  upFraction: number | undefined;
  leagueCount: number;
}) {
  const title = describeConfidence(score, upFraction, leagueCount);
  if (score === undefined) {
    return (
      <span className="text-muted-foreground" title={title}>
        {formatConfidence(score)}
      </span>
    );
  }
  return (
    <Badge variant={TIER_VARIANT[confidenceTier(score)]} title={title}>
      {formatConfidence(score)}
    </Badge>
  );
}
