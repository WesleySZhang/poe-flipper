"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LiquidityTierFilter } from "@/components/liquidity-tier-filter";
import { FaustusPriceButton } from "@/components/faustus-price-button";
import { ItemHistoryRow } from "@/components/item-history-row";
import { ItemHistoryCard } from "@/components/item-history-card";
import { MobileSortControl } from "@/components/mobile-sort-control";
import { Pagination } from "@/components/pagination";
import { SearchInput } from "@/components/search-input";
import { SortableHeader } from "@/components/sortable-header";
import { NumericRangeFilter, isWithinRange, type NumericRange } from "@/components/numeric-range-filter";
import type { DivinationFlip } from "@/lib/divination-flips";
import type { LiquidityTier } from "@/lib/liquidity";
import { fullStackListed, stockRangeTitle } from "@/lib/exchange-route";
import { CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";
import { currentLeagueDay } from "@/lib/league-day";
import { sortByKey, toggleSort, type SortState } from "@/lib/sort";
import { formatPriceValue, priceUnitLabel, type PriceUnit } from "@/lib/price-unit";

const PAGE_SIZE = 25;

type SortKey = "cost" | "reward" | "profitPercent" | "profitAbs";

// Same variant-as-state vocabulary as ConfidenceBadge/the Currency Exchange Flip page - no
// green/amber, red stays reserved for warnings.
const LIQUIDITY_VARIANT = { high: "default", medium: "secondary", low: "outline" } as const;
const LIQUIDITY_LABEL = { high: "High", medium: "Medium", low: "Low" } as const;

// Instant-buy figures are undefined for a card with no exchange market; such rows are filtered out
// before rendering, but the types can't know that.
function formatOptionalPrice(chaosValue: number | undefined, divineValue: number | undefined, unit: PriceUnit): string {
  return chaosValue === undefined ? "—" : formatPriceValue(chaosValue, divineValue, unit);
}

function formatOptionalPercent(ratio: number | undefined): string {
  return ratio === undefined ? "—" : `${Math.round((ratio - 1) * 100)}%`;
}

async function fetchDivinationFlips(): Promise<DivinationFlip[]> {
  const res = await fetch("/api/divination-flips");
  if (!res.ok) return [];
  return res.json();
}

/**
 * Divination cards where buying a full stack and turning it in costs less than the reward is
 * worth right now - see lib/divination-flips.ts for the profit math and lib/divination-cards.ts
 * for why only cards with a single, deterministic, currently-priced reward are listed at all.
 */
export function DivinationFlipsPanel() {
  const [flips, setFlips] = useState<DivinationFlip[]>([]);
  const [searchText, setSearchText] = useState("");
  const [costRange, setCostRange] = useState<NumericRange>({});
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "profitPercent", direction: "desc" });
  const [priceUnit, setPriceUnit] = useState<PriceUnit>("chaos");
  // Instant buy: the stack bought off other players' sell orders (see lib/divination-flips.ts)
  // instead of with a buy order. Cost, Profit % and Profit switch to those figures.
  const [instant, setInstant] = useState(false);
  // Low hidden by default, same "curated by default" convention as the flip-suggestions table's
  // confidence filter and the Currency Exchange Flip page's own liquidity filter - a Low-confidence
  // row here means one of the two legs (buying the card, selling the reward) is thinly traded, so
  // the listed profit is more likely to be one lucky listing than an actually fillable flip.
  const [hiddenConfidenceTiers, setHiddenConfidenceTiers] = useState<Set<LiquidityTier>>(() => new Set(["low"]));
  const [isPending, startTransition] = useTransition();
  const currentDay = currentLeagueDay(CURRENT_LEAGUE_START_DATE);

  useEffect(() => {
    startTransition(async () => {
      setFlips(await fetchDivinationFlips());
      setPage(0);
    });
  }, []);

  // The figures the table shows for the active price unit and buy mode, derived once per change so
  // sorting, filtering and rendering all read the same values. Undefined cost means the card can't
  // be bought that way right now (no Divine market, or no exchange market for an instant buy).
  const enriched = useMemo(
    () =>
      flips.map((f) => {
        const divine = priceUnit === "divine";
        // An instant buy also needs a full stack listed that hour; without one the card is hidden.
        const instantBuyable = fullStackListed(divine ? f.buyStockDivine : f.buyStock, f.stackSize);
        const cost = instant
          ? instantBuyable
            ? divine
              ? f.instantCostDivineValue
              : f.instantCostChaosValue
            : undefined
          : divine
            ? f.stackCostDivineValue
            : f.stackCostChaosValue;
        const profit = instant
          ? divine
            ? f.instantProfitDivineValue
            : f.instantProfitChaosValue
          : divine
            ? f.profitDivineValue
            : f.profitChaosValue;
        const reward = divine ? f.rewardDivineValue : f.rewardChaosValue;
        return {
          ...f,
          shownCost: cost,
          shownReward: reward,
          shownProfit: profit,
          shownRatio: cost !== undefined && cost > 0 && reward !== undefined ? reward / cost : undefined,
          // Divine mode buys the cards on their Divine market, so its liquidity is that market's.
          shownConfidence: divine ? (f.confidenceDivine ?? f.confidence) : f.confidence,
        };
      }),
    [flips, priceUnit, instant]
  );

  const sorted = useMemo(
    () =>
      sortByKey(enriched, sort, (f, key) => {
        switch (key) {
          case "cost":
            return f.shownCost;
          case "reward":
            return f.shownReward;
          case "profitPercent":
            return f.shownRatio;
          case "profitAbs":
            return f.shownProfit;
        }
      }),
    [enriched, sort]
  );

  const normalizedSearch = searchText.trim().toLowerCase();
  const visible = sorted.filter((f) => {
    return (
      (f.name.toLowerCase().includes(normalizedSearch) || f.rewardName.toLowerCase().includes(normalizedSearch)) &&
      // No cost means the card can't be bought that way this hour (no Divine market, or no
      // exchange market for an instant buy).
      f.shownCost !== undefined &&
      isWithinRange(f.shownCost, costRange) &&
      !hiddenConfidenceTiers.has(f.shownConfidence)
    );
  });
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageStart = Math.min(page, pageCount - 1) * PAGE_SIZE;
  const paged = visible.slice(pageStart, pageStart + PAGE_SIZE);

  function changeSearchText(text: string) {
    setSearchText(text);
    setPage(0);
  }

  function changeCostRange(range: NumericRange) {
    setCostRange(range);
    setPage(0);
  }

  function changePriceUnit(unit: PriceUnit) {
    setPriceUnit(unit);
    setCostRange(unit === "divine" ? { min: 1 } : {});
    setPage(0);
  }

  function changeInstant(value: boolean) {
    setInstant(value);
    setPage(0);
  }

  function toggleConfidenceTier(tier: LiquidityTier) {
    setHiddenConfidenceTiers((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
    setPage(0);
  }

  function handleSort(key: SortKey) {
    setSort((prev) => toggleSort(prev, key));
    setPage(0);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <CardTitle className="flex items-center gap-2">
          Divination Card Flips
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
      <CardContent className="flex flex-col gap-4">
        {priceUnit === "divine" && (
          <p
            className="text-xs text-muted-foreground"
            title="Cards at their own Divine market price on the Currency Exchange; rewards at their chaos price, converted"
          >
            Only cards traded for divines this hour
          </p>
        )}
        <div className="flex flex-wrap items-end gap-4">
          <SearchInput value={searchText} onChange={changeSearchText} placeholder="Search cards or rewards..." />
          <NumericRangeFilter
            key={priceUnit}
            label={`stack cost (${priceUnitLabel(priceUnit)})`}
            onChange={changeCostRange}
            initialMin={priceUnit === "divine" ? 1 : undefined}
          />
          <Button
            type="button"
            variant={instant ? "default" : "outline"}
            aria-pressed={instant}
            onClick={() => changeInstant(!instant)}
            title="Buy the stack off other players' sell orders instead of with a buy order"
          >
            Instant buy
          </Button>
        </div>
        {isPending && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">Loading divination card flips...</p>
          </div>
        )}
        {!isPending && flips.length === 0 && (
          <p className="text-sm text-muted-foreground">No priceable divination card flips available right now.</p>
        )}
        {!isPending && flips.length > 0 && (
          <MobileSortControl
            options={[
              { key: "cost", label: `Cost (${priceUnitLabel(priceUnit)})` },
              { key: "reward", label: `Sell (${priceUnitLabel(priceUnit)})` },
              { key: "profitPercent", label: "Profit %" },
              { key: "profitAbs", label: `Profit (${priceUnitLabel(priceUnit)})` },
            ]}
            sort={sort}
            onSort={handleSort}
            filterLabel="Confidence"
            filter={<LiquidityTierFilter hidden={hiddenConfidenceTiers} onToggle={toggleConfidenceTier} large />}
          />
        )}
        {!isPending && flips.length > 0 && (
          // -mx-4 cancels CardContent's own px-4, so these rows bleed out to the Card's edge -
          // same pattern as flip-suggestions-panel.tsx's own mobile card list.
          <div className="-mx-4 flex flex-col gap-2 sm:hidden">
            {paged.map((f) => (
              <ItemHistoryCard
                key={f.name}
                displayName={f.name}
                category="currency"
                historyName={f.name}
                currentDay={currentDay}
                priceUnit={priceUnit}
                expandable={false}
                fields={[
                  {
                    label: "Confidence",
                    value: (
                      <Badge
                        variant={LIQUIDITY_VARIANT[f.shownConfidence]}
                        title="Weaker of the two legs' liquidity: buying the card, selling the reward. Not the item-growth confidence score used elsewhere in this app - a card's reward is fixed, not a forecast."
                      >
                        {LIQUIDITY_LABEL[f.shownConfidence]}
                      </Badge>
                    ),
                    emphasized: true,
                  },
                  { label: "Stack", value: `x${f.stackSize}` },
                  { label: "Reward", value: f.rewardQuantity > 1 ? `${f.rewardQuantity}x ${f.rewardName}` : f.rewardName },
                  {
                    label: "Min/Max",
                    value:
                      f.buyMinChaosValue !== undefined && f.buyMaxChaosValue !== undefined ? (
                        <span title={stockRangeTitle(priceUnit === "divine" ? f.buyStockDivine : f.buyStock)}>
                          {formatPriceValue(f.buyMinChaosValue, f.buyMinDivineValue, priceUnit)} &ndash;{" "}
                          {formatPriceValue(f.buyMaxChaosValue, f.buyMaxDivineValue, priceUnit)}
                        </span>
                      ) : f.faustusTradeable ? (
                        <FaustusPriceButton name={f.name} priceUnit={priceUnit} />
                      ) : (
                        "—"
                      ),
                  },
                  { label: `Profit (${priceUnitLabel(priceUnit)})`, value: formatOptionalPrice(f.shownProfit, f.shownProfit, priceUnit) },
                ]}
                rightFields={[
                  { label: `Cost (${priceUnitLabel(priceUnit)})`, value: formatOptionalPrice(f.shownCost, f.shownCost, priceUnit) },
                  { label: `Sell (${priceUnitLabel(priceUnit)})`, value: formatPriceValue(f.rewardChaosValue, f.rewardDivineValue, priceUnit) },
                  { label: "Profit %", value: formatOptionalPercent(f.shownRatio), emphasized: true },
                ]}
              />
            ))}
          </div>
        )}
        {!isPending && flips.length > 0 && (
          // Keyed on flips.length, not paged.length - the header (and the Confidence column's tier
          // filter it carries) must stay visible even when every row is currently filtered out, same
          // reasoning as the flip-suggestions table's Confidence column.
          <Table className="hidden sm:table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px] sm:w-[180px]">Card</TableHead>
                <TableHead className="text-right">Stack</TableHead>
                <SortableHeader label={`Cost (${priceUnitLabel(priceUnit)})`} sortKey="cost" sort={sort} onSort={handleSort} />
                <TableHead className="text-right">Min/Max</TableHead>
                <TableHead>Reward</TableHead>
                <SortableHeader label={`Sell (${priceUnitLabel(priceUnit)})`} sortKey="reward" sort={sort} onSort={handleSort} />
                <SortableHeader label="Profit %" sortKey="profitPercent" sort={sort} onSort={handleSort} />
                <SortableHeader
                  label={`Profit (${priceUnitLabel(priceUnit)})`}
                  sortKey="profitAbs"
                  sort={sort}
                  onSort={handleSort}
                />
                <TableHead>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-muted-foreground">Confidence</span>
                    <LiquidityTierFilter hidden={hiddenConfidenceTiers} onToggle={toggleConfidenceTier} />
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((f) => (
                <ItemHistoryRow
                  key={f.name}
                  displayName={f.name}
                  category="currency"
                  historyName={f.name}
                  currentDay={currentDay}
                  priceUnit={priceUnit}
                  colSpan={9}
                  expandable={false}
                >
                  <TableCell className="text-right text-muted-foreground">x{f.stackSize}</TableCell>
                  <TableCell className="text-right">{formatOptionalPrice(f.shownCost, f.shownCost, priceUnit)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      {f.buyMinChaosValue !== undefined && f.buyMaxChaosValue !== undefined ? (
                        <span
                          className="cursor-help text-right text-muted-foreground"
                          title={stockRangeTitle(priceUnit === "divine" ? f.buyStockDivine : f.buyStock)}
                        >
                          {formatPriceValue(f.buyMinChaosValue, f.buyMinDivineValue, priceUnit)} &ndash;{" "}
                          {formatPriceValue(f.buyMaxChaosValue, f.buyMaxDivineValue, priceUnit)}
                        </span>
                      ) : f.faustusTradeable ? (
                        <FaustusPriceButton name={f.name} priceUnit={priceUnit} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[160px] truncate" title={f.rewardName}>
                    {f.rewardQuantity > 1 ? `${f.rewardQuantity}x ${f.rewardName}` : f.rewardName}
                  </TableCell>
                  <TableCell className="text-right">{formatPriceValue(f.rewardChaosValue, f.rewardDivineValue, priceUnit)}</TableCell>
                  <TableCell className="text-right font-medium">{formatOptionalPercent(f.shownRatio)}</TableCell>
                  <TableCell className="text-right">{formatOptionalPrice(f.shownProfit, f.shownProfit, priceUnit)}</TableCell>
                  <TableCell>
                    <div className="flex justify-center">
                      <Badge
                        variant={LIQUIDITY_VARIANT[f.shownConfidence]}
                        title="Weaker of the two legs' liquidity: buying the card, selling the reward. Not the item-growth confidence score used elsewhere in this app - a card's reward is fixed, not a forecast."
                      >
                        {LIQUIDITY_LABEL[f.shownConfidence]}
                      </Badge>
                    </div>
                  </TableCell>
                </ItemHistoryRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!isPending && flips.length > 0 && visible.length === 0 && (
          <p className="text-sm text-muted-foreground">No cards match the current filters.</p>
        )}
        <Pagination page={Math.min(page, pageCount - 1)} pageCount={pageCount} totalRows={visible.length} onPageChange={setPage} />
      </CardContent>
    </Card>
  );
}
