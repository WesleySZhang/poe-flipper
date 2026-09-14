"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CategoryFilter } from "@/components/category-filter";
import { Pagination } from "@/components/pagination";
import { SearchInput } from "@/components/search-input";
import { SortableHeader } from "@/components/sortable-header";
import { NumericRangeFilter, isWithinRange, type NumericRange } from "@/components/numeric-range-filter";
import { ALL_CATEGORIES, isDefaultEnabledCategory, humanizeCategoryName } from "@/lib/category-reliability";
import type { FlipSuggestion } from "@/lib/flip-suggestions";
import { CURRENT_LEAGUE, CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";
import { currentLeagueDay } from "@/lib/league-day";
import { sortByKey, toggleSort, type SortState } from "@/lib/sort";
import {
  activePrice,
  activeRatio,
  formatPercentChange,
  formatPriceValue,
  priceUnitLabel,
  type PriceUnit,
} from "@/lib/price-unit";

const PAGE_SIZE = 25;

type SortKey = "current" | "predicted" | "change";

async function fetchFlipSuggestions(durationDays: number): Promise<FlipSuggestion[]> {
  const res = await fetch(`/api/flip-suggestions?durationDays=${durationDays}`);
  if (!res.ok) return [];
  return res.json();
}

export function FlipSuggestionsPanel() {
  const [suggestions, setSuggestions] = useState<FlipSuggestion[]>([]);
  const [durationDays, setDurationDays] = useState(3);
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(
    () => new Set(ALL_CATEGORIES.filter((c) => !isDefaultEnabledCategory(c)))
  );
  const [page, setPage] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [currentRange, setCurrentRange] = useState<NumericRange>({});
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "change", direction: "desc" });
  const [priceUnit, setPriceUnit] = useState<PriceUnit>("chaos");
  const [isPending, startTransition] = useTransition();

  const currentDay = currentLeagueDay(CURRENT_LEAGUE_START_DATE);
  // Backtesting shows the model's predictions correlate well with what actually happens early in a
  // league, but that correlation collapses past ~day 30 once the economy has largely settled.
  const isStaleLeagueDay = currentDay > 30;

  useEffect(() => {
    startTransition(async () => {
      setSuggestions(await fetchFlipSuggestions(durationDays));
      setPage(0);
    });
  }, [durationDays]);

  // Re-sort whenever the unit changes too: in divine mode a price/change column should order by
  // real value, not chaos value. Rows with no divine figure for the active sort column sort last.
  const sortedSuggestions = useMemo(
    () =>
      sortByKey(suggestions, sort, (s, key) => {
        switch (key) {
          case "current":
            return activePrice(s.currentChaosValue, s.currentDivineValue, priceUnit);
          case "predicted":
            return activePrice(s.predictedChaosValue, s.predictedDivineValue, priceUnit);
          case "change":
            return activeRatio(s.avgGrowthRatio, s.avgGrowthRatioDivine, priceUnit);
        }
      }),
    [suggestions, sort, priceUnit]
  );
  const normalizedSearch = searchText.trim().toLowerCase();
  const visibleSuggestions = sortedSuggestions.filter((s) => {
    // Undefined only when the row has no divine figure at all - don't exclude on a check we can't
    // actually evaluate, same philosophy as the sort/format helpers elsewhere in this unit.
    const activeCurrent = activePrice(s.currentChaosValue, s.currentDivineValue, priceUnit);
    return (
      !hiddenCategories.has(s.filterCategory) &&
      (activeCurrent === undefined || isWithinRange(activeCurrent, currentRange)) &&
      s.name.toLowerCase().includes(normalizedSearch)
    );
  });
  const pageCount = Math.max(1, Math.ceil(visibleSuggestions.length / PAGE_SIZE));
  const pageStart = Math.min(page, pageCount - 1) * PAGE_SIZE;
  const pagedSuggestions = visibleSuggestions.slice(pageStart, pageStart + PAGE_SIZE);

  function toggleCategory(category: string) {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
    setPage(0);
  }

  function selectAllCategories(categories: string[]) {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      categories.forEach((c) => next.delete(c));
      return next;
    });
    setPage(0);
  }

  function deselectAllCategories(categories: string[]) {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      categories.forEach((c) => next.add(c));
      return next;
    });
    setPage(0);
  }

  function changeSearchText(text: string) {
    setSearchText(text);
    setPage(0);
  }

  function changeCurrentRange(range: NumericRange) {
    setCurrentRange(range);
    setPage(0);
  }

  function handleSort(key: SortKey) {
    setSort((prev) => toggleSort(prev, key));
    setPage(0);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            Flip suggestions
            {isPending && (
              <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading...
              </span>
            )}
          </CardTitle>
          <CardDescription>
            Projected from Day-{currentDay} to Day-{currentDay + durationDays} of {CURRENT_LEAGUE}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-end gap-4">
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
          <div className="flex flex-col gap-1.5">
            <Label>Prices in</Label>
            <Tabs value={priceUnit} onValueChange={(value) => setPriceUnit(value as PriceUnit)}>
              <TabsList>
                <TabsTrigger value="chaos">Chaos</TabsTrigger>
                <TabsTrigger value="divine">Divine</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isStaleLeagueDay && (
          <p className="text-xs font-medium text-red-600 dark:text-red-500">
            Warning: day {currentDay} is past day 30 of the league - the economy has largely settled by this point, so
            predictions can be misleading.
          </p>
        )}
        <CategoryFilter
          categories={ALL_CATEGORIES}
          selected={new Set(ALL_CATEGORIES.filter((c) => !hiddenCategories.has(c)))}
          onToggle={toggleCategory}
          onSelectAll={selectAllCategories}
          onDeselectAll={deselectAllCategories}
        />
        <div className="flex flex-wrap items-end gap-4">
          <SearchInput value={searchText} onChange={changeSearchText} />
          <NumericRangeFilter label={`cost (${priceUnitLabel(priceUnit)})`} onChange={changeCurrentRange} />
        </div>
        {isPending && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">Loading flip suggestions...</p>
          </div>
        )}
        {!isPending && suggestions.length === 0 && (
          <p className="text-sm text-muted-foreground">No historical matches found for current live prices yet.</p>
        )}
        {!isPending && suggestions.length > 0 && visibleSuggestions.length === 0 && (
          <p className="text-sm text-muted-foreground">No suggestions match the current filters.</p>
        )}
        {pagedSuggestions.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[280px]">Item</TableHead>
                <TableHead>Category</TableHead>
                <SortableHeader
                  label={`Current (${priceUnitLabel(priceUnit)})`}
                  sortKey="current"
                  sort={sort}
                  onSort={handleSort}
                />
                <SortableHeader
                  label={`Predicted (${priceUnitLabel(priceUnit)})`}
                  sortKey="predicted"
                  sort={sort}
                  onSort={handleSort}
                />
                <SortableHeader label="Change" sortKey="change" sort={sort} onSort={handleSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedSuggestions.map((s) => (
                <TableRow key={`${s.category}-${s.name}`}>
                  <TableCell>
                    <div
                      tabIndex={0}
                      className="max-w-[280px] truncate hover:overflow-x-auto hover:text-clip focus:overflow-x-auto focus:text-clip"
                      title={s.name}
                    >
                      {s.name}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{humanizeCategoryName(s.filterCategory)}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPriceValue(s.currentChaosValue, s.currentDivineValue, priceUnit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPriceValue(s.predictedChaosValue, s.predictedDivineValue, priceUnit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPercentChange(s.avgGrowthRatio, s.avgGrowthRatioDivine, priceUnit)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pagination
          page={Math.min(page, pageCount - 1)}
          pageCount={pageCount}
          totalRows={visibleSuggestions.length}
          onPageChange={setPage}
        />
      </CardContent>
    </Card>
  );
}
