"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LiquidityTierFilter } from "@/components/liquidity-tier-filter";
import { ItemHistoryRow } from "@/components/item-history-row";
import { ItemHistoryCard } from "@/components/item-history-card";
import { MobileSortControl } from "@/components/mobile-sort-control";
import { Pagination } from "@/components/pagination";
import { SearchInput } from "@/components/search-input";
import { SortableHeader } from "@/components/sortable-header";
import { NumericRangeFilter, isWithinRange, type NumericRange } from "@/components/numeric-range-filter";
import type { DustValueRow } from "@/lib/dust-value";
import type { LiquidityTier } from "@/lib/liquidity";
import { DUST_ASSUMED_QUALITY, DUST_MAX_ITEM_LEVEL, dustFor } from "@/lib/dust";
import { CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";
import { currentLeagueDay } from "@/lib/league-day";
import { formatItemDisplayName } from "@/lib/poe-ninja";
import { sortByKey, toggleSort, type SortState } from "@/lib/sort";
import { tradeSearchUrl } from "@/lib/trade-site";
import { activePrice, formatPriceValue, priceUnitLabel, type PriceUnit } from "@/lib/price-unit";

const PAGE_SIZE = 25;

type SortKey = "price" | "dust" | "dustPerPrice";

// Same badge vocabulary as the Divination Card Flips / Currency Exchange Flip pages.
const LIQUIDITY_VARIANT = { high: "default", medium: "secondary", low: "outline" } as const;
const LIQUIDITY_LABEL = { high: "High", medium: "Medium", low: "Low" } as const;

function formatDust(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function confidenceTitle(sellerCount: number | undefined): string {
  return `${sellerCount ?? "?"} sellers on poe.ninja`;
}

async function fetchDustValues(): Promise<DustValueRow[]> {
  const res = await fetch("/api/dust-value");
  if (!res.ok) return [];
  return res.json();
}

/**
 * Uniques ranked by Thaumaturgic Dust per chaos for Kingsmarch disenchanting - see
 * lib/dust-value.ts for how each unique's price line is picked and lib/dust.ts for the formula.
 * Item level only scales the dust figures (the same factor for every unique), so changing it never
 * reorders the table.
 */
export function DustValuePanel() {
  const [rows, setRows] = useState<DustValueRow[]>([]);
  const [searchText, setSearchText] = useState("");
  const [priceRange, setPriceRange] = useState<NumericRange>({});
  const [itemLevelText, setItemLevelText] = useState(String(DUST_MAX_ITEM_LEVEL));
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "dustPerPrice", direction: "desc" });
  const [priceUnit, setPriceUnit] = useState<PriceUnit>("chaos");
  // Low hidden by default, same "curated by default" convention as the other tables: a unique with
  // only a few sellers may not really be buyable at the listed price.
  const [hiddenConfidenceTiers, setHiddenConfidenceTiers] = useState<Set<LiquidityTier>>(() => new Set(["low"]));
  const [isPending, startTransition] = useTransition();
  const currentDay = currentLeagueDay(CURRENT_LEAGUE_START_DATE);

  useEffect(() => {
    startTransition(async () => {
      setRows(await fetchDustValues());
      setPage(0);
    });
  }, []);

  const parsedItemLevel = Number(itemLevelText);
  const itemLevel = itemLevelText.trim() !== "" && Number.isFinite(parsedItemLevel) ? parsedItemLevel : DUST_MAX_ITEM_LEVEL;

  const enriched = useMemo(
    () =>
      rows.map((r) => {
        const dust = dustFor(r.dustValue, itemLevel);
        const price = activePrice(r.chaosValue, r.divineValue, priceUnit);
        return { ...r, dust, dustPerPrice: price !== undefined && price > 0 ? dust / price : undefined };
      }),
    [rows, itemLevel, priceUnit]
  );

  const sorted = useMemo(
    () =>
      sortByKey(enriched, sort, (r, key) => {
        switch (key) {
          case "price":
            return activePrice(r.chaosValue, r.divineValue, priceUnit);
          case "dust":
            return r.dust;
          case "dustPerPrice":
            return r.dustPerPrice;
        }
      }),
    [enriched, sort, priceUnit]
  );

  const normalizedSearch = searchText.trim().toLowerCase();
  const visible = sorted.filter((r) => {
    const price = activePrice(r.chaosValue, r.divineValue, priceUnit);
    return (
      r.name.toLowerCase().includes(normalizedSearch) &&
      price !== undefined &&
      isWithinRange(price, priceRange) &&
      !hiddenConfidenceTiers.has(r.confidence)
    );
  });
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageStart = Math.min(page, pageCount - 1) * PAGE_SIZE;
  const paged = visible.slice(pageStart, pageStart + PAGE_SIZE);
  const unit = priceUnitLabel(priceUnit);

  function changeSearchText(text: string) {
    setSearchText(text);
    setPage(0);
  }

  function changePriceRange(range: NumericRange) {
    setPriceRange(range);
    setPage(0);
  }

  function changePriceUnit(value: PriceUnit) {
    setPriceUnit(value);
    setPriceRange({});
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
          Dust Value
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
        <p
          className="text-xs text-muted-foreground"
          title="Kingsmarch disenchanting. Dust values from poedb; prices from poe.ninja. Quality adds 2% dust per point."
        >
          Thaumaturgic Dust per {priceUnit === "chaos" ? "chaos" : "divine"} spent, at {DUST_ASSUMED_QUALITY}% quality
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <SearchInput value={searchText} onChange={changeSearchText} placeholder="Search uniques..." />
          <NumericRangeFilter key={priceUnit} label={`price (${unit})`} onChange={changePriceRange} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dust-item-level" title="Dust scales ×1 at item level 65 up to ×20 at 84+. poe.ninja prices don't say a listing's item level.">
              Item level
            </Label>
            <Input
              id="dust-item-level"
              type="number"
              min={1}
              max={100}
              value={itemLevelText}
              onChange={(e) => setItemLevelText(e.target.value)}
              className="w-20"
            />
          </div>
        </div>
        {isPending && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">Loading dust values...</p>
          </div>
        )}
        {!isPending && rows.length === 0 && <p className="text-sm text-muted-foreground">No priced uniques right now.</p>}
        {!isPending && rows.length > 0 && (
          <MobileSortControl
            options={[
              { key: "dustPerPrice", label: `Dust / ${unit}` },
              { key: "dust", label: "Dust" },
              { key: "price", label: `Price (${unit})` },
            ]}
            sort={sort}
            onSort={handleSort}
            filterLabel="Confidence"
            filter={<LiquidityTierFilter hidden={hiddenConfidenceTiers} onToggle={toggleConfidenceTier} large />}
          />
        )}
        {!isPending && rows.length > 0 && (
          // -mx-4 cancels CardContent's own px-4, same as the other panels' mobile card lists.
          <div className="-mx-4 flex flex-col gap-2 sm:hidden">
            {paged.map((r) => (
              <ItemHistoryCard
                key={r.name}
                displayName={formatItemDisplayName(r.name, r.variant)}
                category="item"
                historyName={r.name}
                variant={r.variant}
                currentDay={currentDay}
                priceUnit={priceUnit}
                expandable={false}
                tradeUrl={tradeSearchUrl(r.name, r.variant, { minItemLevel: itemLevel })}
                fields={[
                  {
                    label: "Confidence",
                    value: (
                      <Badge variant={LIQUIDITY_VARIANT[r.confidence]} title={confidenceTitle(r.sellerCount)}>
                        {LIQUIDITY_LABEL[r.confidence]}
                      </Badge>
                    ),
                    emphasized: true,
                  },
                  { label: "Dust", value: formatDust(r.dust) },
                ]}
                rightFields={[
                  { label: `Price (${unit})`, value: formatPriceValue(r.chaosValue, r.divineValue, priceUnit) },
                  { label: `Dust / ${unit}`, value: r.dustPerPrice === undefined ? "—" : formatDust(r.dustPerPrice), emphasized: true },
                ]}
              />
            ))}
          </div>
        )}
        {!isPending && rows.length > 0 && (
          // Keyed on rows.length, not paged.length, so the Confidence filter in the header stays
          // reachable when every row is filtered out - same as the other tables.
          <Table className="hidden sm:table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[240px] sm:w-[320px]">Unique</TableHead>
                <SortableHeader label={`Price (${unit})`} sortKey="price" sort={sort} onSort={handleSort} />
                <SortableHeader label="Dust" sortKey="dust" sort={sort} onSort={handleSort} />
                <SortableHeader label={`Dust / ${unit}`} sortKey="dustPerPrice" sort={sort} onSort={handleSort} />
                <TableHead>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-muted-foreground">Confidence</span>
                    <LiquidityTierFilter hidden={hiddenConfidenceTiers} onToggle={toggleConfidenceTier} />
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((r) => (
                <ItemHistoryRow
                  key={r.name}
                  displayName={formatItemDisplayName(r.name, r.variant)}
                  category="item"
                  historyName={r.name}
                  variant={r.variant}
                  currentDay={currentDay}
                  priceUnit={priceUnit}
                  colSpan={5}
                  expandable={false}
                  tradeUrl={tradeSearchUrl(r.name, r.variant, { minItemLevel: itemLevel })}
                >
                  <TableCell className="text-right">{formatPriceValue(r.chaosValue, r.divineValue, priceUnit)}</TableCell>
                  <TableCell className="text-right">{formatDust(r.dust)}</TableCell>
                  <TableCell className="text-right font-medium">{r.dustPerPrice === undefined ? "—" : formatDust(r.dustPerPrice)}</TableCell>
                  <TableCell>
                    <div className="flex justify-center">
                      <Badge variant={LIQUIDITY_VARIANT[r.confidence]} title={confidenceTitle(r.sellerCount)}>
                        {LIQUIDITY_LABEL[r.confidence]}
                      </Badge>
                    </div>
                  </TableCell>
                </ItemHistoryRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!isPending && rows.length > 0 && visible.length === 0 && (
          <p className="text-sm text-muted-foreground">No uniques match the current filters.</p>
        )}
        <Pagination page={Math.min(page, pageCount - 1)} pageCount={pageCount} totalRows={visible.length} onPageChange={setPage} />
      </CardContent>
    </Card>
  );
}
