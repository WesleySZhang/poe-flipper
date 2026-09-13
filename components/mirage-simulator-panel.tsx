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
import { NumericRangeFilter, isWithinRange, type NumericRange } from "@/components/numeric-range-filter";
import { ALL_CATEGORIES, isDefaultEnabledCategory, humanizeCategoryName } from "@/lib/category-reliability";
import { MIRAGE_LEAGUE_LENGTH_DAYS } from "@/lib/mirage-league";
import { activeRatio, formatPriceValue, formatRatio, priceUnitLabel, type PriceUnit } from "@/lib/price-unit";
import type { MirageSimulationRow } from "@/lib/mirage-simulator";

async function fetchMirageSimulation(currentDay: number, durationDays: number): Promise<MirageSimulationRow[]> {
  const res = await fetch(`/api/mirage-simulation?currentDay=${currentDay}&durationDays=${durationDays}`);
  if (!res.ok) return [];
  return res.json();
}

const PAGE_SIZE = 25;

export function MirageSimulatorPanel() {
  const [currentDay, setCurrentDay] = useState(2);
  const [durationDays, setDurationDays] = useState(3);
  const [rows, setRows] = useState<MirageSimulationRow[]>([]);
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(
    () => new Set(ALL_CATEGORIES.filter((c) => !isDefaultEnabledCategory(c)))
  );
  const [page, setPage] = useState(0);
  const [nowChaosRange, setNowChaosRange] = useState<NumericRange>({});
  const [priceUnit, setPriceUnit] = useState<PriceUnit>("chaos");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      setRows(await fetchMirageSimulation(currentDay, durationDays));
      setPage(0);
    });
  }, [currentDay, durationDays]);

  const targetDay = currentDay + durationDays;
  // Backtesting shows the model's predictions correlate well with what actually happens early in a
  // league, but that correlation collapses past ~day 30 once the economy has largely settled.
  const isStaleLeagueDay = currentDay > 30;
  // Re-rank whenever the unit changes: in divine mode the ordering should follow predicted real
  // value growth, not chaos growth. Rows with no divine ratio sort last.
  const sortedRows = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          (activeRatio(b.predictedRatio, b.predictedRatioDivine, priceUnit) ?? -Infinity) -
          (activeRatio(a.predictedRatio, a.predictedRatioDivine, priceUnit) ?? -Infinity)
      ),
    [rows, priceUnit]
  );
  const visibleRows = sortedRows.filter(
    (r) => !hiddenCategories.has(r.filterCategory) && isWithinRange(r.actualNowChaos, nowChaosRange)
  );
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const pageStart = Math.min(page, pageCount - 1) * PAGE_SIZE;
  const pagedRows = visibleRows.slice(pageStart, pageStart + PAGE_SIZE);

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

  function changeNowChaosRange(range: NumericRange) {
    setNowChaosRange(range);
    setPage(0);
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            Mirage league simulator
            {isPending && (
              <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Predicting...
              </span>
            )}
          </CardTitle>
          <CardDescription>
            Simulates Day-{currentDay} of Mirage and predicts Day-{targetDay} prices
            against actual prices
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="currentDay">Current day</Label>
            <Input
              id="currentDay"
              type="number"
              min={0}
              max={MIRAGE_LEAGUE_LENGTH_DAYS}
              value={currentDay}
              onChange={(e) => {
                const value = Number(e.target.value);
                setCurrentDay(Number.isFinite(value) ? Math.max(0, Math.min(MIRAGE_LEAGUE_LENGTH_DAYS, value)) : 0);
              }}
              className="w-24"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="durationDays">Project forward (days)</Label>
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
          <p className="text-sm font-medium text-red-600 dark:text-red-500">
            Warning: day {currentDay} is past day 30 of the league - the economy has largely settled by this point, so
            predictions can be wildly misleading.
          </p>
        )}
        <CategoryFilter
          categories={ALL_CATEGORIES}
          selected={new Set(ALL_CATEGORIES.filter((c) => !hiddenCategories.has(c)))}
          onToggle={toggleCategory}
          onSelectAll={selectAllCategories}
          onDeselectAll={deselectAllCategories}
        />
        {isPending && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">
              Predicting day {currentDay} &rarr; day {targetDay}... first run after a server restart can take a while
              (it has to scan the full price history once).
            </p>
          </div>
        )}
        {!isPending && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No historical matches for day {currentDay} to day {targetDay} - try an earlier day or shorter duration.
          </p>
        )}
        {!isPending && rows.length > 0 && visibleRows.length === 0 && (
          <p className="text-sm text-muted-foreground">No rows match the current filters.</p>
        )}
        {!isPending && pagedRows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    Now ({priceUnitLabel(priceUnit)})
                    <NumericRangeFilter label="Now (c)" range={nowChaosRange} onChange={changeNowChaosRange} />
                  </div>
                </TableHead>
                <TableHead className="text-right">Predicted ({priceUnitLabel(priceUnit)})</TableHead>
                <TableHead className="text-right">Actual future ({priceUnitLabel(priceUnit)})</TableHead>
                <TableHead className="text-right">Predicted x</TableHead>
                <TableHead className="text-right">Actual x</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedRows.map((r) => (
                <TableRow key={`${r.category}-${r.name}`}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{humanizeCategoryName(r.filterCategory)}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPriceValue(r.actualNowChaos, r.actualNowDivine, priceUnit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPriceValue(r.predictedChaosValue, r.predictedDivineValue, priceUnit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPriceValue(r.actualFutureChaos, r.actualFutureDivine, priceUnit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatRatio(r.predictedRatio, r.predictedRatioDivine, priceUnit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatRatio(r.actualRatio, r.actualRatioDivine, priceUnit)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!isPending && (
          <Pagination
            page={Math.min(page, pageCount - 1)}
            pageCount={pageCount}
            totalRows={visibleRows.length}
            onPageChange={setPage}
          />
        )}
      </CardContent>
    </Card>
  );
}
