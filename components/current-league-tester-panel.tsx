"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { ItemNameCombobox, type KnownItemName } from "@/components/item-name-combobox";
import { CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";
import { currentLeagueDay } from "@/lib/league-day";

interface PredictResponse {
  avgRatio: number;
  leagueCount: number;
  confidence: number;
  upFraction: number;
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

  const predictedPrice = prediction ? price * prediction.avgRatio : undefined;
  const predictedPctChange = prediction ? Math.round((prediction.avgRatio - 1) * 100) : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Spot-check a prediction
          {isPending && (
            <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading...
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end gap-4">
          <ItemNameCombobox names={names} selected={selected} onSelect={handleSelect} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="price">Price (c)</Label>
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
              <span className="text-lg font-semibold">{predictedPrice!.toFixed(2)}c</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Predicted %</span>
              <span className="text-lg font-semibold">
                {predictedPctChange! >= 0 ? "+" : ""}
                {predictedPctChange}%
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Confidence</span>
              <ConfidenceBadge
                score={prediction.confidence}
                upFraction={prediction.upFraction}
                leagueCount={prediction.leagueCount}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
