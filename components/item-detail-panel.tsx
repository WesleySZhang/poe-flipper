"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { FaustusPriceButton } from "@/components/faustus-price-button";
import { PriceHistoryChart, type PriceHistoryFetchState } from "@/components/price-history-chart";
import { reconstructAllFlipSuggestions, type PrecomputedPredictions } from "@/lib/predicted-suggestion";
import type { FlipSuggestion, PredictionCurvePoint } from "@/lib/flip-suggestions";
import type { ItemDetail } from "@/lib/item-detail";
import type { DivinationFlip } from "@/lib/divination-flips";
import type { LeagueSeries } from "@/lib/price-history";
import { CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";
import { currentLeagueDay } from "@/lib/league-day";
import { poeWikiUrl } from "@/lib/poe-ninja";
import { liquidityTier } from "@/lib/liquidity";
import {
  activePrice,
  formatPercentChange,
  formatPriceValue,
  priceUnitLabel,
  type PriceUnit,
} from "@/lib/price-unit";

const MIN_DURATION_DAYS = 1;
// Matches lib/flip-suggestions.ts's own CURVE_MAX_DURATION_DAYS - can't import that constant
// directly (that module is "server-only"), so this is redeclared here the same way
// flip-suggestions-panel.tsx's own PRECOMPUTED_MAX_DURATION_DAYS already does. Past this, the
// slider still drags (via the live per-duration fallback below), it's just no longer instant.
const PRECOMPUTED_MAX_DURATION_DAYS = 30;

const LIQUIDITY_VARIANT = { high: "default", medium: "secondary", low: "outline" } as const;
const LIQUIDITY_LABEL = { high: "High", medium: "Medium", low: "Low" } as const;

async function fetchPrecomputedFile(): Promise<PrecomputedPredictions | null> {
  try {
    const res = await fetch("/api/flip-suggestions/precomputed");
    if (!res.ok) return null;
    return (await res.json()) as PrecomputedPredictions | null;
  } catch {
    return null;
  }
}

async function fetchFlipSuggestions(durationDays: number): Promise<FlipSuggestion[]> {
  const res = await fetch(`/api/flip-suggestions?durationDays=${durationDays}`);
  if (!res.ok) return [];
  return res.json();
}

async function fetchItemDetail(
  category: "currency" | "item",
  historyName: string,
  variant: string | undefined
): Promise<ItemDetail | undefined> {
  const params = new URLSearchParams({ category, name: historyName });
  if (variant) params.set("variant", variant);
  const res = await fetch(`/api/item-detail?${params}`);
  if (!res.ok) return undefined;
  return res.json();
}

/** Same whole-list-then-find-by-name approach as fetchItemDetail's siblings elsewhere in this app -
 *  the divination-flips list is small enough that fetching it whole and finding one row client-side
 *  needs no new per-item backend endpoint. */
async function fetchDivinationFlip(name: string): Promise<DivinationFlip | undefined> {
  const res = await fetch("/api/divination-flips");
  if (!res.ok) return undefined;
  const flips = (await res.json()) as DivinationFlip[];
  return flips.find((f) => f.name === name);
}

/** log(now/then) -> a %-change string, "-" when the sparkline didn't reach back that far. */
function formatMomentum(logValue: number | undefined): string {
  if (logValue === undefined || !Number.isFinite(logValue)) return "—";
  const pct = (Math.exp(logValue) - 1) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

interface ItemDetailPanelProps {
  category: "currency" | "item";
  historyName: string;
  variant?: string;
}

/**
 * The per-item detail page's actual content (see app/item/[category]/[key]/page.tsx, the thin
 * server wrapper around this). Reuses the exact same client-side precomputed-predictions
 * reconstruction components/flip-suggestions-panel.tsx already relies on for its "Days ahead"
 * slider - see lib/predicted-suggestion.ts - so dragging this page's own slider is just as instant,
 * with zero new prediction-serving code. Everything ELSE about the item (poe.ninja's seller count/
 * sparkline, GGG's Currency Exchange spread) doesn't depend on the chosen duration at all, so it's
 * fetched once, separately - see lib/item-detail.ts's own module doc.
 */
export function ItemDetailPanel({ category, historyName, variant }: ItemDetailPanelProps) {
  const [precomputedData, setPrecomputedData] = useState<PrecomputedPredictions | null | undefined>(undefined);
  const [liveSuggestions, setLiveSuggestions] = useState<FlipSuggestion[]>([]);
  const [durationDays, setDurationDays] = useState(7);
  const [dragValue, setDragValue] = useState<number | undefined>(undefined);
  const [priceUnit, setPriceUnit] = useState<PriceUnit>("chaos");
  const [isPending, startTransition] = useTransition();
  const [detail, setDetail] = useState<ItemDetail | null | undefined>(undefined);
  // undefined = still loading/not applicable (never fetched for category "item"); null = fetched
  // but this name isn't a priceable divination card flip (see lib/divination-cards.ts's scoping
  // rule for why most cards, and every non-card currency item, land here).
  const [divinationFlip, setDivinationFlip] = useState<DivinationFlip | null | undefined>(undefined);
  const [historyState, setHistoryState] = useState<PriceHistoryFetchState>({ status: "loading" });
  const [curveState, setCurveState] = useState<
    { status: "loading" } | { status: "error" } | { status: "loaded"; points: PredictionCurvePoint[] }
  >({ status: "loading" });

  const sliderValue = dragValue ?? Math.min(durationDays, PRECOMPUTED_MAX_DURATION_DAYS);
  const inputValue = dragValue ?? durationDays;
  const currentDay = currentLeagueDay(CURRENT_LEAGUE_START_DATE);

  // Once on mount - same "fetch the whole file once, reconstruct every duration locally" pattern
  // as flip-suggestions-panel.tsx.
  useEffect(() => {
    fetchPrecomputedFile().then(setPrecomputedData);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ category, name: historyName });
    if (variant) params.set("variant", variant);
    fetch(`/api/price-history?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error("price-history request failed");
        return res.json() as Promise<LeagueSeries[]>;
      })
      .then((series) => setHistoryState({ status: "loaded", series }))
      .catch(() => setHistoryState({ status: "error" }));

    fetch(`/api/flip-suggestion-curve?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error("flip-suggestion-curve request failed");
        return res.json() as Promise<PredictionCurvePoint[]>;
      })
      .then((points) => setCurveState({ status: "loaded", points }))
      .catch(() => setCurveState({ status: "error" }));

    fetchItemDetail(category, historyName, variant).then((d) => setDetail(d ?? null));
    // Divination cards are always category "currency" - only worth checking there. Most currency
    // items resolve to null quickly (a plain currency name is never in the divination-flips list).
    if (category === "currency") {
      fetchDivinationFlip(historyName).then((f) => setDivinationFlip(f ?? null));
    }
    // Deliberately no `variant`/`category` change support beyond mount - this page is always
    // rendered fresh per item (a new URL, hence a new component instance) by the Link that
    // navigates here (see components/item-history-row.tsx), never re-parented onto a different item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clientSuggestions = useMemo(
    () => reconstructAllFlipSuggestions(precomputedData, inputValue),
    [precomputedData, inputValue]
  );
  const committedClientSuggestions = useMemo(
    () => reconstructAllFlipSuggestions(precomputedData, durationDays),
    [precomputedData, durationDays]
  );

  useEffect(() => {
    if (committedClientSuggestions !== undefined) return; // already answerable locally
    startTransition(async () => {
      setLiveSuggestions(await fetchFlipSuggestions(durationDays));
    });
  }, [durationDays, committedClientSuggestions]);

  const displaySuggestions = clientSuggestions ?? liveSuggestions;
  const displayDurationDays = clientSuggestions !== undefined ? inputValue : durationDays;
  const suggestion = displaySuggestions.find(
    (s) => s.category === category && s.historyName === historyName && (s.variant ?? "") === (variant ?? "")
  );

  const currentValue = suggestion ? activePrice(suggestion.currentChaosValue, suggestion.currentDivineValue, priceUnit) : undefined;
  const predictedValue = suggestion
    ? activePrice(suggestion.predictedChaosValue, suggestion.predictedDivineValue, priceUnit)
    : undefined;
  const predictedCurve =
    curveState.status === "loaded"
      ? curveState.points.map((p) => ({
          durationDays: p.durationDays,
          value: p.predictedChaosValue === null ? undefined : activePrice(p.predictedChaosValue, p.predictedDivineValue ?? undefined, priceUnit),
        }))
      : undefined;

  const liquidity = detail?.faustus ? liquidityTier(detail.faustus.volumeChaos) : detail?.liquidity;

  // Same derivations as currency-exchange-flip-panel.tsx's own `enriched` - this card mirrors that
  // table's per-row numbers exactly, just for this one item, so "today's Currency Exchange flip"
  // means the same thing in both places.
  const faustus = detail?.faustus;
  const faustusChaosRatio = faustus ? faustus.sellChaosValue / faustus.buyChaosValue : undefined;
  const faustusDivineRatio =
    faustus?.buyDivineValue !== undefined && faustus?.sellDivineValue !== undefined
      ? faustus.sellDivineValue / faustus.buyDivineValue
      : undefined;
  const profitPer1000Gold =
    faustus?.goldCost && faustus.goldCost.perItem > 0 ? (faustus.spreadChaosValue / faustus.goldCost.perItem) * 1000 : undefined;

  // Divine-denominated profit ratio, same pattern as divination-flips-panel.tsx's own `enriched`.
  const divinationProfitRatioDivine =
    divinationFlip?.rewardDivineValue !== undefined &&
    divinationFlip?.stackCostDivineValue !== undefined &&
    divinationFlip.stackCostDivineValue > 0
      ? divinationFlip.rewardDivineValue / divinationFlip.stackCostDivineValue
      : undefined;

  return (
    <div className="flex flex-col gap-4">
      <a
        href={poeWikiUrl(historyName)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
      >
        View on poewiki
        <ExternalLink className="size-3.5" />
      </a>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="flex items-center gap-2">
              Days ahead
              {isPending && (
                <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading...
                </span>
              )}
            </Label>
            <Input
              type="number"
              aria-label="Days ahead (exact)"
              min={MIN_DURATION_DAYS}
              value={inputValue}
              onChange={(e) => {
                const value = Number(e.target.value);
                setDurationDays(Number.isFinite(value) && value > 0 ? Math.floor(value) : MIN_DURATION_DAYS);
              }}
              className="w-20"
            />
            <Slider
              aria-label="Days ahead"
              min={MIN_DURATION_DAYS}
              max={PRECOMPUTED_MAX_DURATION_DAYS}
              step={1}
              value={sliderValue}
              onValueChange={(value) => setDragValue(value)}
              onValueCommitted={(value) => {
                setDurationDays(value);
                setDragValue(undefined);
              }}
              className="w-56"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Prices in</Label>
            <Tabs value={priceUnit} onValueChange={(value) => setPriceUnit(value as PriceUnit)}>
              <TabsList>
                <TabsTrigger value="chaos">Chaos</TabsTrigger>
                <TabsTrigger value="divine">Divine</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-x-8 gap-y-3">
          {!suggestion && (
            <p className="text-sm text-muted-foreground">No live price for this item right now.</p>
          )}
          {suggestion && (
            <>
              <Stat label={`Current (${priceUnitLabel(priceUnit)})`} value={formatPriceValue(suggestion.currentChaosValue, suggestion.currentDivineValue, priceUnit)} />
              <Stat label={`Predicted (${priceUnitLabel(priceUnit)})`} value={formatPriceValue(suggestion.predictedChaosValue, suggestion.predictedDivineValue, priceUnit)} />
              <Stat label="Change" value={formatPercentChange(suggestion.avgGrowthRatio, suggestion.avgGrowthRatioDivine, priceUnit)} />
            </>
          )}
          <Stat label="Category" value={detail?.filterCategory ?? "—"} />
          {category === "item" && <Stat label="Sellers listing this" value={detail?.sellerCount?.toString() ?? "—"} />}
        </CardContent>
      </Card>

      {/* Desktop: chart takes the left 70%, every other "additional info" card stacks in the
          remaining 30% on the right, so the chart and its detail cards are visible side by side
          without scrolling past one to see the other. Below `lg`, there's no room for a 30%-wide
          info column to stay legible, so it falls back to the normal full-width stack (chart, then
          every card in the same order) - same breakpoint the rest of this app uses for its own
          desktop-only layouts (e.g. ItemHistoryRow's table vs. ItemHistoryCard's mobile stack). */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <Card className="lg:w-[70%] lg:min-w-0 lg:shrink-0">
          <CardContent>
            {/* A dedicated page has a full column's width to give the chart, not a table cell's - the
                same fixed 2.5:1 aspect ratio (components/price-history-chart.tsx) just renders bigger
                and more legible as a result, with no changes to the chart component itself. */}
            <PriceHistoryChart
              state={historyState}
              currentDay={currentDay}
              targetDay={currentDay + displayDurationDays}
              currentValue={currentValue}
              predictedValue={predictedValue}
              predictedCurve={predictedCurve}
              priceUnit={priceUnit}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4 lg:w-[30%] lg:min-w-0 lg:shrink-0">
          <Card>
            <CardHeader>
              <CardTitle>Historical performance</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {suggestion ? (
                <>
                  <ConfidenceBadge
                    score={priceUnit === "chaos" ? suggestion.confidence : suggestion.confidenceDivine}
                    upFraction={priceUnit === "chaos" ? suggestion.upFraction : suggestion.upFractionDivine}
                    leagueCount={priceUnit === "chaos" ? suggestion.leagueCount : suggestion.leagueCountDivine}
                    forecastSpread={priceUnit === "chaos" ? suggestion.forecastSpread : undefined}
                  />
                  {/* The same facts buildFlipRationale() (lib/predicted-suggestion.ts) used to word as
                      one long sentence, as scannable stats instead - a narrow sidebar card reads a
                      wall of prose worse than a table does, and every number here (model prediction,
                      the past-leagues baseline it adjusted, league count, hit rate, forecast width) is
                      already independently meaningful without the connecting sentence. */}
                  <div className="flex flex-wrap gap-x-8 gap-y-3">
                    <Stat
                      label={`Model prediction (${displayDurationDays}d)`}
                      value={formatPercentChange(suggestion.avgGrowthRatio, suggestion.avgGrowthRatioDivine, priceUnit)}
                    />
                    <Stat
                      label="Past-leagues avg"
                      value={formatPercentChange(suggestion.baselineGrowthRatio, suggestion.baselineGrowthRatioDivine, priceUnit)}
                    />
                    <Stat
                      label="Leagues used"
                      value={`${priceUnit === "chaos" ? suggestion.leagueCount : suggestion.leagueCountDivine}`}
                    />
                    <Stat
                      label="Leagues up"
                      value={`${Math.round((priceUnit === "chaos" ? suggestion.upFraction : (suggestion.upFractionDivine ?? suggestion.upFraction)) * 100)}%`}
                    />
                    {priceUnit === "chaos" && suggestion.forecastSpread !== undefined && (
                      <Stat label="Forecast precision" value={`~${suggestion.forecastSpread.toFixed(1)}x`} />
                    )}
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Not enough data to score this item right now.</p>
              )}
            </CardContent>
          </Card>

          {detail?.momentum && (
            <Card>
              <CardHeader>
                <CardTitle>Recent momentum</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="1-day" value={formatMomentum(detail.momentum.mom1)} />
                <Stat label="3-day" value={formatMomentum(detail.momentum.mom3)} />
                <Stat label="6-day" value={formatMomentum(detail.momentum.mom6)} />
                <Stat
                  label="Volatility (6-day)"
                  value={Number.isFinite(detail.momentum.vol6) ? `${(detail.momentum.vol6 * 100).toFixed(1)}%` : "—"}
                />
                <Stat label="Acceleration" value={formatMomentum(detail.momentum.accel)} />
              </CardContent>
            </Card>
          )}

          {category === "currency" && detail?.faustus && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <CardTitle>Currency Exchange (Faustus)</CardTitle>
                <FaustusPriceButton name={historyName} priceUnit={priceUnit} />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                  Prices are roughly 2 hours stale
                </p>
                <div className="flex flex-wrap gap-x-8 gap-y-3">
                  <Stat label={`Buy (${priceUnitLabel(priceUnit)})`} value={formatPriceValue(detail.faustus.buyChaosValue, detail.faustus.buyDivineValue, priceUnit)} />
                  <Stat label={`Sell (${priceUnitLabel(priceUnit)})`} value={formatPriceValue(detail.faustus.sellChaosValue, detail.faustus.sellDivineValue, priceUnit)} />
                  {/* Same Profit %/Profit (abs)/Profit per 1k gold this card is ranked by on the
                      Currency Exchange Flip table (components/currency-exchange-flip-panel.tsx) - "today's
                      Currency Exchange flip" for this one item, not a separate metric invented for this page. */}
                  <Stat label="Profit %" value={formatPercentChange(faustusChaosRatio ?? 1, faustusDivineRatio, priceUnit)} />
                  <Stat
                    label={`Profit (${priceUnitLabel(priceUnit)})`}
                    value={formatPriceValue(detail.faustus.spreadChaosValue, detail.faustus.sellDivineValue !== undefined && detail.faustus.buyDivineValue !== undefined ? detail.faustus.sellDivineValue - detail.faustus.buyDivineValue : undefined, priceUnit)}
                  />
                  {profitPer1000Gold !== undefined && (
                    <Stat
                      label="Profit / 1k gold"
                      value={`${detail.faustus.goldCost?.approximate ? "~" : ""}${formatPriceValue(profitPer1000Gold, undefined, "chaos")}`}
                    />
                  )}
                  <Stat label="Volume (chaos)" value={detail.faustus.volumeChaos.toLocaleString()} />
                  <Stat label="Item volume" value={detail.faustus.volumeItem.toLocaleString()} />
                  <Stat label="Item stock" value={detail.faustus.itemStock.toLocaleString()} />
                  <Stat label="Chaos stock" value={detail.faustus.chaosStock.toLocaleString()} />
                  {detail.faustus.goldCost && (
                    <Stat
                      label="Gold cost"
                      value={`${detail.faustus.goldCost.approximate ? "~" : ""}${detail.faustus.goldCost.perItem.toLocaleString()}`}
                    />
                  )}
                  {liquidity && (
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Liquidity</span>
                      <Badge variant={LIQUIDITY_VARIANT[liquidity]} className="w-fit">
                        {LIQUIDITY_LABEL[liquidity]}
                      </Badge>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {divinationFlip && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <CardTitle>Divination Card Flip</CardTitle>
                {divinationFlip.faustusTradeable && <FaustusPriceButton name={historyName} priceUnit={priceUnit} />}
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                  Buying a full stack of {divinationFlip.stackSize} and turning it in for{" "}
                  {divinationFlip.rewardQuantity > 1 ? `${divinationFlip.rewardQuantity}x ` : ""}
                  {divinationFlip.rewardName} at today&apos;s prices - see the Divination Card Flips page for
                  every card ranked this way.
                </p>
                <div className="flex flex-wrap gap-x-8 gap-y-3">
                  <Stat label="Stack size" value={`x${divinationFlip.stackSize}`} />
                  <Stat
                    label={`Cost (${priceUnitLabel(priceUnit)})`}
                    value={formatPriceValue(divinationFlip.stackCostChaosValue, divinationFlip.stackCostDivineValue, priceUnit)}
                  />
                  <Stat
                    label="Reward"
                    value={
                      divinationFlip.rewardQuantity > 1
                        ? `${divinationFlip.rewardQuantity}x ${divinationFlip.rewardName}`
                        : divinationFlip.rewardName
                    }
                  />
                  <Stat
                    label={`Sell (${priceUnitLabel(priceUnit)})`}
                    value={formatPriceValue(divinationFlip.rewardChaosValue, divinationFlip.rewardDivineValue, priceUnit)}
                  />
                  {divinationFlip.buyMinChaosValue !== undefined && divinationFlip.buyMaxChaosValue !== undefined && (
                    <Stat
                      label={`Min/Max (${priceUnitLabel(priceUnit)})`}
                      value={`${formatPriceValue(divinationFlip.buyMinChaosValue, divinationFlip.buyMinDivineValue, priceUnit)} – ${formatPriceValue(divinationFlip.buyMaxChaosValue, divinationFlip.buyMaxDivineValue, priceUnit)}`}
                    />
                  )}
                  <Stat
                    label="Profit %"
                    value={formatPercentChange(divinationFlip.profitPercent / 100 + 1, divinationProfitRatioDivine, priceUnit)}
                  />
                  <Stat
                    label={`Profit (${priceUnitLabel(priceUnit)})`}
                    value={formatPriceValue(divinationFlip.profitChaosValue, divinationFlip.profitDivineValue, priceUnit)}
                  />
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Confidence</span>
                    <Badge
                      variant={LIQUIDITY_VARIANT[divinationFlip.confidence]}
                      className="w-fit"
                      title="Weaker of the two legs' liquidity: buying the card, selling the reward. Not the item-growth confidence score used elsewhere in this app - a card's reward is fixed, not a forecast."
                    >
                      {LIQUIDITY_LABEL[divinationFlip.confidence]}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}
