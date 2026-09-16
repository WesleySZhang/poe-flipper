"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LiquidityTierFilter } from "@/components/liquidity-tier-filter";
import { Pagination } from "@/components/pagination";
import { SearchInput } from "@/components/search-input";
import { SortableHeader } from "@/components/sortable-header";
import { NumericRangeFilter, isWithinRange, type NumericRange } from "@/components/numeric-range-filter";
import type { FaustusSpread } from "@/lib/faustus";
import type { GoldCost } from "@/lib/faustus-gold";
import { CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";
import { currentLeagueDay } from "@/lib/league-day";
import { liquidityTier, type LiquidityTier } from "@/lib/liquidity";
import { sortByKey, toggleSort, type SortState } from "@/lib/sort";
import { activePrice, activeRatio, formatPercentChange, formatPriceValue, priceUnitLabel, type PriceUnit } from "@/lib/price-unit";

const PAGE_SIZE = 25;

type SortKey = "buy" | "sell" | "profitPercent" | "profitAbs" | "gold" | "profitPerGold";

// Same variant-as-state vocabulary as ConfidenceBadge - no green/amber, red stays reserved for warnings.
const LIQUIDITY_VARIANT = { high: "default", medium: "secondary", low: "outline" } as const;
const LIQUIDITY_LABEL = { high: "High", medium: "Medium", low: "Low" } as const;

function formatGold(cost: GoldCost | undefined): string {
  if (!cost) return "—";
  const rounded = cost.perItem >= 1 ? Math.round(cost.perItem) : cost.perItem.toFixed(3);
  return `${cost.approximate ? "~" : ""}${rounded}g`;
}

function goldTitle(cost: GoldCost | undefined): string | undefined {
  if (!cost) return "No published gold cost for this item.";
  return cost.approximate ? cost.note : undefined;
}

async function fetchFaustusSpreads(): Promise<FaustusSpread[]> {
  const res = await fetch("/api/faustus-spreads");
  if (!res.ok) return [];
  return res.json();
}

/**
 * Same-day Currency Exchange (GGG's "Faustus" NPC) flip opportunities: items whose buy price and
 * sell price diverged within the last closed exchange hour, ranked by spread percent - see this
 * data's two real caveats surfaced directly in the UI rather than buried in a comment: the exchange
 * API is purely historical (roughly 2 hours stale, and "buy"/"sell" are the low/high ends of one
 * hour's trade range, not two live standing orders), and a wide percentage on a barely-traded item
 * is usually just ratio-rounding noise, not a real opportunity - the Liquidity column is how to tell
 * the two apart.
 */
export function CurrencyExchangeFlipPanel() {
  const [spreads, setSpreads] = useState<FaustusSpread[]>([]);
  const [searchText, setSearchText] = useState("");
  const [buyRange, setBuyRange] = useState<NumericRange>({});
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "profitPercent", direction: "desc" });
  const [priceUnit, setPriceUnit] = useState<PriceUnit>("chaos");
  // Starts empty (show every tier) rather than hiding Low by default - unlike the flip-suggestions
  // table's confidence filter, this page's whole point is showing raw spreads and letting the
  // Liquidity column inform the judgment call, not curating them away up front.
  const [hiddenLiquidityTiers, setHiddenLiquidityTiers] = useState<Set<LiquidityTier>>(() => new Set());
  const [isPending, startTransition] = useTransition();

  const currentDay = currentLeagueDay(CURRENT_LEAGUE_START_DATE);
  // Same threshold as the flip-suggestions table's stale-league warning - late in a league most
  // items' prices have settled, so there's less day-to-day movement left to create a spread at all.
  const isStaleLeagueDay = currentDay > 30;

  useEffect(() => {
    startTransition(async () => {
      setSpreads(await fetchFaustusSpreads());
      setPage(0);
    });
  }, []);

  // Every row derived once per fetch/sort-key change - profit-per-gold and the two ratios aren't
  // stored on FaustusSpread itself since they're pure derivations of fields it already has.
  const enriched = useMemo(
    () =>
      spreads.map((s) => {
        const chaosRatio = s.sellChaosValue / s.buyChaosValue;
        const divineRatio =
          s.buyDivineValue !== undefined && s.sellDivineValue !== undefined
            ? s.sellDivineValue / s.buyDivineValue
            : undefined;
        const spreadDivineValue =
          s.buyDivineValue !== undefined && s.sellDivineValue !== undefined
            ? s.sellDivineValue - s.buyDivineValue
            : undefined;
        // Gold is charged on the BUY side per unit (see lib/faustus-gold.ts), so this is the chaos
        // profit a flip nets back per 1000 gold spent acquiring the item - the number that actually
        // matters once gold, not chaos, caps how much you can flip in a day. Always chaos, even in
        // divine display mode - gold has no divine-denominated equivalent to convert to.
        const profitPer1000Gold =
          s.goldCost && s.goldCost.perItem > 0 ? (s.spreadChaosValue / s.goldCost.perItem) * 1000 : undefined;
        return { ...s, chaosRatio, divineRatio, spreadDivineValue, profitPer1000Gold, liquidity: liquidityTier(s.volumeChaos) };
      }),
    [spreads]
  );

  const sorted = useMemo(
    () =>
      sortByKey(enriched, sort, (s, key) => {
        switch (key) {
          case "buy":
            return activePrice(s.buyChaosValue, s.buyDivineValue, priceUnit);
          case "sell":
            return activePrice(s.sellChaosValue, s.sellDivineValue, priceUnit);
          case "profitPercent":
            return activeRatio(s.chaosRatio, s.divineRatio, priceUnit);
          case "profitAbs":
            return activePrice(s.spreadChaosValue, s.spreadDivineValue, priceUnit);
          case "gold":
            return s.goldCost?.perItem;
          case "profitPerGold":
            return s.profitPer1000Gold;
        }
      }),
    [enriched, sort, priceUnit]
  );

  const normalizedSearch = searchText.trim().toLowerCase();
  const visible = sorted.filter((s) => {
    const buyActive = activePrice(s.buyChaosValue, s.buyDivineValue, priceUnit);
    return (
      s.name.toLowerCase().includes(normalizedSearch) &&
      (buyActive === undefined || isWithinRange(buyActive, buyRange)) &&
      !hiddenLiquidityTiers.has(s.liquidity)
    );
  });
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageStart = Math.min(page, pageCount - 1) * PAGE_SIZE;
  const paged = visible.slice(pageStart, pageStart + PAGE_SIZE);

  function changeSearchText(text: string) {
    setSearchText(text);
    setPage(0);
  }

  function changeBuyRange(range: NumericRange) {
    setBuyRange(range);
    setPage(0);
  }

  function changePriceUnit(unit: PriceUnit) {
    setPriceUnit(unit);
    setBuyRange(unit === "divine" ? { min: 1 } : {});
    setPage(0);
  }

  function toggleLiquidityTier(tier: LiquidityTier) {
    setHiddenLiquidityTiers((prev) => {
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
          Currency Exchange Flip
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
        {isStaleLeagueDay && (
          <p className="text-xs font-medium text-red-600 dark:text-red-500">
            Warning: Day-{currentDay} is late in the league - flips may not be achievable.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          GGG&apos;s exchange data is purely historical - roughly 2 hours stale, and Buy/Sell are the low/high ends of
          the last closed hour&apos;s trade range, not two live standing orders right now. A wide profit % on a Low
          liquidity item is usually just a couple of trades, not a real opportunity - check Liquidity before acting.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <SearchInput value={searchText} onChange={changeSearchText} placeholder="Search items..." />
          <NumericRangeFilter
            key={priceUnit}
            label={`buy price (${priceUnitLabel(priceUnit)})`}
            onChange={changeBuyRange}
            initialMin={priceUnit === "divine" ? 1 : undefined}
          />
        </div>
        {isPending && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">Loading Currency Exchange spreads...</p>
          </div>
        )}
        {!isPending && spreads.length === 0 && (
          <p className="text-sm text-muted-foreground">No Currency Exchange spread data available right now.</p>
        )}
        {!isPending && spreads.length > 0 && (
          // Keyed on spreads.length, not paged.length - the header (and the Liquidity column's tier
          // filter it carries) must stay visible even when every row is currently filtered out, same
          // reasoning as the flip-suggestions table's Confidence column.
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px] sm:w-[200px] lg:w-[240px]">Item</TableHead>
                <SortableHeader label={`Buy (${priceUnitLabel(priceUnit)})`} sortKey="buy" sort={sort} onSort={handleSort} />
                <SortableHeader label={`Sell (${priceUnitLabel(priceUnit)})`} sortKey="sell" sort={sort} onSort={handleSort} />
                <SortableHeader label="Profit %" sortKey="profitPercent" sort={sort} onSort={handleSort} />
                {/* Absolute profit/gold/profit-per-gold are dropped below `sm` - mobile keeps
                    Buy/Sell/Profit %/Liquidity, the "should I even look at this" essentials, same
                    reasoning as the other tables' mobile column set. Liquidity sits last so it stays
                    the rightmost column at every width, not just on mobile. */}
                <SortableHeader
                  label={`Profit (${priceUnitLabel(priceUnit)})`}
                  sortKey="profitAbs"
                  sort={sort}
                  onSort={handleSort}
                  className="hidden sm:table-cell"
                />
                <SortableHeader label="Gold" sortKey="gold" sort={sort} onSort={handleSort} className="hidden sm:table-cell" />
                <SortableHeader
                  label="Profit / 1k gold"
                  sortKey="profitPerGold"
                  sort={sort}
                  onSort={handleSort}
                  className="hidden max-w-[90px] sm:table-cell"
                />
                <TableHead>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-muted-foreground">Liquidity</span>
                    <LiquidityTierFilter hidden={hiddenLiquidityTiers} onToggle={toggleLiquidityTier} />
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((s) => (
                <TableRow key={s.name}>
                  <TableCell className="max-w-[140px] truncate sm:max-w-[200px] lg:max-w-[240px]" title={s.name}>
                    {s.name}
                  </TableCell>
                  <TableCell className="text-right">{formatPriceValue(s.buyChaosValue, s.buyDivineValue, priceUnit)}</TableCell>
                  <TableCell className="text-right">{formatPriceValue(s.sellChaosValue, s.sellDivineValue, priceUnit)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatPercentChange(s.chaosRatio, s.divineRatio, priceUnit)}
                  </TableCell>
                  <TableCell className="hidden text-right sm:table-cell">
                    {formatPriceValue(s.spreadChaosValue, s.spreadDivineValue, priceUnit)}
                  </TableCell>
                  <TableCell className="hidden text-right sm:table-cell" title={goldTitle(s.goldCost)}>
                    {formatGold(s.goldCost)}
                  </TableCell>
                  <TableCell className="hidden max-w-[90px] text-right sm:table-cell">
                    {s.profitPer1000Gold !== undefined ? (
                      <span title={s.goldCost?.approximate ? "Estimated - gold cost for this item is a family estimate, not a confirmed value" : undefined}>
                        {s.goldCost?.approximate ? "~" : ""}
                        {formatPriceValue(s.profitPer1000Gold, undefined, "chaos")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-center">
                      <Badge
                        variant={LIQUIDITY_VARIANT[s.liquidity]}
                        title={`${s.volumeChaos.toLocaleString()}c volume, ${s.volumeItem.toLocaleString()} units traded, ${s.stock.toLocaleString()} listed this hour`}
                      >
                        {LIQUIDITY_LABEL[s.liquidity]}
                      </Badge>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!isPending && spreads.length > 0 && visible.length === 0 && (
          <p className="text-sm text-muted-foreground">No items match the current filters.</p>
        )}
        <Pagination page={Math.min(page, pageCount - 1)} pageCount={pageCount} totalRows={visible.length} onPageChange={setPage} />
      </CardContent>
    </Card>
  );
}
