"use client";

import { useEffect, useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CategoryFilter } from "@/components/category-filter";
import { Pagination } from "@/components/pagination";
import { ALL_CATEGORIES, isDefaultEnabledCategory, humanizeCategoryName } from "@/lib/category-reliability";
import type { FlipSuggestion } from "@/lib/flip-suggestions";
import { CURRENT_LEAGUE, CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";
import { currentLeagueDay } from "@/lib/league-day";

const PAGE_SIZE = 25;

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

  const visibleSuggestions = suggestions.filter((s) => !hiddenCategories.has(s.filterCategory));
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle>Flip suggestions</CardTitle>
          <CardDescription>
            Projected from day {currentDay} to day {currentDay + durationDays} of {CURRENT_LEAGUE}
          </CardDescription>
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
        {isPending && <Skeleton className="h-48 w-full" />}
        {!isPending && suggestions.length === 0 && (
          <p className="text-sm text-muted-foreground">No historical matches found for current live prices yet.</p>
        )}
        {!isPending && suggestions.length > 0 && visibleSuggestions.length === 0 && (
          <p className="text-sm text-muted-foreground">No suggestions match the selected categories.</p>
        )}
        {pagedSuggestions.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Current (c)</TableHead>
                <TableHead className="text-right">Predicted (c)</TableHead>
                <TableHead className="text-right">Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedSuggestions.map((s) => (
                <TableRow key={`${s.category}-${s.name}`}>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{humanizeCategoryName(s.filterCategory)}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{s.currentChaosValue.toFixed(1)}</TableCell>
                  <TableCell className="text-right">{s.predictedChaosValue.toFixed(1)}</TableCell>
                  <TableCell className="text-right">{Math.round((s.avgGrowthRatio - 1) * 100)}%</TableCell>
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
