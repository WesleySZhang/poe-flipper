"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { ItemNameCombobox, type KnownItemName } from "@/components/item-name-combobox";
import { CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";
import { currentLeagueDay } from "@/lib/league-day";
import { activeConfidence } from "@/lib/confidence";
import { activeRatio, formatPercentChange, formatPriceValue, priceUnitLabel, type PriceUnit } from "@/lib/price-unit";

interface PredictResponse {
  avgRatio: number;
  /** Same growth measured in divines - chaos debasement divided out, see lib/growth-ratios.ts's
   *  GrowthRatioRow.avgRatioDivine. Undefined when too few leagues had a Divine Orb rate to average. */
  avgRatioDivine?: number;
  leagueCount: number;
  leagueCountDivine: number;
  confidence: number;
  confidenceDivine?: number;
  upFraction: number;
  upFractionDivine?: number;
}

/** Formats one already-unit-specific value using the same decimals/suffix rules as the normal
 *  prediction tables' formatPriceValue - the unused half of that pair is just filler, since here
 *  (unlike the tables) there's only ever one number, already in whichever unit is selected. */
function formatSinglePrice(value: number | undefined, unit: PriceUnit): string {
  if (value === undefined) return "—";
  return unit === "chaos" ? formatPriceValue(value, undefined, "chaos") : formatPriceValue(0, value, "divine");
}

async function fetchNames(): Promise<KnownItemName[]> {
  const res = await fetch("/api/item-names");
  if (!res.ok) return [];
  return res.json();
}

async function fetchPrediction(
  item: KnownItemName,
  currentDay: number,
  durationDays: number
): Promise<{ data?: PredictResponse; error?: string }> {
  const params = new URLSearchParams({
    category: item.category,
    name: item.name,
    currentDay: String(currentDay),
    durationDays: String(durationDays),
  });
  if (item.variant) params.set("variant", item.variant);
  const res = await fetch(`/api/predict-item?${params}`);
  const body = await res.json();
  if (!res.ok) return { error: body.error ?? "Something went wrong." };
  return { data: body };
}

export function CurrentLeagueTesterPanel() {
  const [names, setNames] = useState<KnownItemName[]>([]);
  const [selected, setSelected] = useState<KnownItemName | null>(null);
  const [price, setPrice] = useState<number>(0);
  const [currentDay, setCurrentDay] = useState(() => currentLeagueDay(CURRENT_LEAGUE_START_DATE));
  const [durationDays, setDurationDays] = useState(3);
  const [priceUnit, setPriceUnit] = useState<PriceUnit>("chaos");
  const [prediction, setPrediction] = useState<PredictResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    fetchNames().then(setNames);
  }, []);

  useEffect(() => {
    if (!selected) return;
    startTransition(async () => {
      const { data, error: err } = await fetchPrediction(selected, currentDay, durationDays);
      setPrediction(data ?? null);
      setError(err ?? null);
    });
  }, [selected, currentDay, durationDays]);

  // Clears any stale prediction the moment the selection itself changes (picked, or the text was
  // edited away from it) - rather than in the effect above, so a new/cleared selection never
  // briefly shows the previous item's result while its own fetch is still in flight.
  function handleSelect(item: KnownItemName | null) {
    setSelected(item);
    setPrediction(null);
    setError(null);
  }

  // Applies the unit-matching ratio directly to the price already typed in that same unit - unlike
  // the normal prediction tables, there's no live Divine Orb rate here to derive one unit's price
  // from the other, so there's nothing to convert: chaos price x chaos ratio, or divine price x
  // divine-denominated (debasement-divided-out) ratio, never mixed.
  const predictedRatio = prediction ? activeRatio(prediction.avgRatio, prediction.avgRatioDivine, priceUnit) : undefined;
  const predictedPrice = predictedRatio !== undefined ? price * predictedRatio : undefined;

  function changePriceUnit(unit: PriceUnit) {
    setPriceUnit(unit);
    // A number typed for one unit is meaningless under the other (e.g. "150" as chaos vs. as
    // divines are wildly different prices) - reset rather than silently reinterpret it.
    setPrice(0);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <CardTitle className="flex items-center gap-2">
          Spot-check a prediction
          {isPending && (
            <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading...
            </span>
          )}
        </CardTitle>
        <div className="flex flex-col gap-1.5">
          <Label>Prices in</Label>
          <Tabs value={priceUnit} onValueChange={(value) => changePriceUnit(value as PriceUnit)}>
            <TabsList>
              <TabsTrigger value="chaos">Chaos</TabsTrigger>
              <TabsTrigger value="divine">Divine</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end gap-4">
          <ItemNameCombobox names={names} selected={selected} onSelect={handleSelect} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="price">Price ({priceUnitLabel(priceUnit)})</Label>
            <Input
              id="price"
              type="number"
              min={0}
              step="any"
              value={price}
              onChange={(e) => {
                const value = Number(e.target.value);
                setPrice(Number.isFinite(value) && value >= 0 ? value : 0);
              }}
              className="w-32"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="currentDay">Current day</Label>
            <Input
              id="currentDay"
              type="number"
              min={0}
              value={currentDay}
              onChange={(e) => {
                const value = Number(e.target.value);
                setCurrentDay(Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
              }}
              className="w-28"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="durationDays">Days ahead</Label>
            <Input
              id="durationDays"
              type="number"
              min={1}
              value={durationDays}
              onChange={(e) => {
                const value = Number(e.target.value);
                setDurationDays(Number.isFinite(value) && value > 0 ? Math.floor(value) : 1);
              }}
              className="w-28"
            />
          </div>
        </div>

        {!selected && <p className="text-sm text-muted-foreground">Search for an item above to get a prediction.</p>}
        {selected && error && <p className="text-sm text-red-600 dark:text-red-500">{error}</p>}
        {selected && !error && prediction && (
          <div className="flex flex-wrap gap-8 rounded-lg border p-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Predicted price</span>
              <span className="text-lg font-semibold">{formatSinglePrice(predictedPrice, priceUnit)}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Predicted %</span>
              <span className="text-lg font-semibold">
                {formatPercentChange(prediction.avgRatio, prediction.avgRatioDivine, priceUnit)}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Confidence</span>
              <ConfidenceBadge
                score={activeConfidence(prediction.confidence, prediction.confidenceDivine, priceUnit)}
                upFraction={priceUnit === "chaos" ? prediction.upFraction : prediction.upFractionDivine}
                leagueCount={priceUnit === "chaos" ? prediction.leagueCount : prediction.leagueCountDivine}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
