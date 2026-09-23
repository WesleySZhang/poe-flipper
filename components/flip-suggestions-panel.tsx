"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CategoryFilter } from "@/components/category-filter";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { ConfidenceTierFilter } from "@/components/confidence-tier-filter";
import { FaustusPriceButton } from "@/components/faustus-price-button";
import { ItemHistoryRow } from "@/components/item-history-row";
import { ItemHistoryCard } from "@/components/item-history-card";
import { MobileSortControl } from "@/components/mobile-sort-control";
import { Pagination } from "@/components/pagination";
import { SearchInput } from "@/components/search-input";
import { SortableHeader } from "@/components/sortable-header";
import { NumericRangeFilter, isWithinRange, type NumericRange } from "@/components/numeric-range-filter";
import { ALL_CATEGORIES, isDefaultEnabledCategory, humanizeCategoryName } from "@/lib/category-reliability";
import type { FlipSuggestion } from "@/lib/flip-suggestions";
import { reconstructAllFlipSuggestions, type PrecomputedPredictions } from "@/lib/predicted-suggestion";
import { CURRENT_LEAGUE_START_DATE } from "@/lib/league-recency";
import { currentLeagueDay } from "@/lib/league-day";
import { activeConfidence, confidenceTier, type ConfidenceTier } from "@/lib/confidence";
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
const MIN_DURATION_DAYS = 1;
// Matches scripts/precompute-predictions.ts's own MAX_DURATION_DAYS - both cap at the learned
// model's trained/validated range (see ml/README.md), and a value precomputed daily for every one
// of these is instant to serve. A duration past this still works (see app/api/flip-suggestions/
// route.ts's fallback), it just costs a live model run for that one request instead of being instant.
// Also the slider's own drag max: past this, dragging no longer updates the table reactively (see
// clientSuggestions below) - every pixel past PRECOMPUTED_MAX_DURATION_DAYS would need a live model
// run to answer, so there's nothing to gain by letting the drag reach further than the range it's
// actually instant across. The paired number input can still type any value past this, same as every
// other "Days ahead" input in this app - it just costs a live compute for that one request.
const PRECOMPUTED_MAX_DURATION_DAYS = 30;

type SortKey = "current" | "predicted" | "change";

async function fetchFlipSuggestions(durationDays: number): Promise<FlipSuggestion[]> {
  const res = await fetch(`/api/flip-suggestions?durationDays=${durationDays}`);
  if (!res.ok) return [];
  return res.json();
}

/** Today's whole precomputed file (every item, every duration 1-30) - fetched once so every
 *  duration's table can be reconstructed locally afterward, with zero further network round-trips.
 *  Resolves to null on any failure (network error, non-200, malformed body), same "just fall back"
 *  contract as fetchFlipSuggestions above - see the component for how that fallback works. */
async function fetchPrecomputedFile(): Promise<PrecomputedPredictions | null> {
  try {
    const res = await fetch("/api/flip-suggestions/precomputed");
    if (!res.ok) return null;
    return (await res.json()) as PrecomputedPredictions | null;
  } catch {
    return null;
  }
}

export function FlipSuggestionsPanel() {
  // Server-fetched fallback, used only for a duration the precomputed file below doesn't cover
  // (past PRECOMPUTED_MAX_DURATION_DAYS, or the file itself missing/stale) - see displaySuggestions.
  const [suggestions, setSuggestions] = useState<FlipSuggestion[]>([]);
  // undefined = not fetched yet; null = fetched but unusable (missing/stale/network error) - both
  // just mean "fall back to suggestions above", same distinction lib/precomputed-predictions.ts's own
  // cache makes server-side. Fetched ONCE (see the effect below), not per duration - the whole point
  // is that every duration 1-30 is already in this one payload, so switching durations (including
  // while dragging the slider) needs zero further network round-trips.
  const [precomputedData, setPrecomputedData] = useState<PrecomputedPredictions | null | undefined>(undefined);
  const [durationDays, setDurationDays] = useState(3);
  // Set only while the thumb is actively being dragged, so dragging updates the visible number
  // instantly without re-fetching on every pixel of movement - undefined the rest of the time, so the
  // slider's displayed value (sliderValue below) just tracks durationDays directly, including when
  // durationDays changes from elsewhere (typing in the number input). Committing (mouse up, or a
  // keyboard step) clears this and updates durationDays itself, which is what the effect below
  // actually fetches on.
  const [dragValue, setDragValue] = useState<number | undefined>(undefined);
  // Clamped: a typed value in the paired number input can exceed the slider's own max (that input is
  // intentionally unbounded, same as every other "Days ahead" input in this app) - the thumb just
  // pins at the end in that case rather than the slider having no valid position to show at all.
  const sliderValue = dragValue ?? Math.min(durationDays, PRECOMPUTED_MAX_DURATION_DAYS);
  // The number input mirrors whichever value is currently "live" - the drag value while dragging (so
  // it updates in real time instead of only on release), durationDays otherwise. Deliberately NOT
  // clamped to PRECOMPUTED_MAX_DURATION_DAYS like sliderValue above - a typed value past the slider's
  // own max should still show the real typed number here, not the slider's clamped display value.
  const inputValue = dragValue ?? durationDays;
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(
    () => new Set(ALL_CATEGORIES.filter((c) => !isDefaultEnabledCategory(c)))
  );
  const [page, setPage] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [currentRange, setCurrentRange] = useState<NumericRange>({});
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "change", direction: "desc" });
  const [priceUnit, setPriceUnit] = useState<PriceUnit>("chaos");
  const [faustusOnly, setFaustusOnly] = useState(false);
  // Low starts hidden - High/Medium only by default, same "curated by default" philosophy as the
  // category filter (see lib/category-reliability.ts's isDefaultEnabledCategory).
  const [hiddenConfidenceTiers, setHiddenConfidenceTiers] = useState<Set<ConfidenceTier>>(() => new Set(["low"]));
  const [isPending, startTransition] = useTransition();

  const currentDay = currentLeagueDay(CURRENT_LEAGUE_START_DATE);
  // Backtesting shows the model's predictions correlate well with what actually happens early in a
  // league, but that correlation collapses past ~day 30 once the economy has largely settled.
  const isStaleLeagueDay = currentDay > 30;

  // Once, on mount - not keyed on anything, since the file itself only changes once a day and
  // covers every duration this page can show. See fetchPrecomputedFile's own doc.
  useEffect(() => {
    fetchPrecomputedFile().then(setPrecomputedData);
  }, []);

  // Reconstructed straight from the already-fetched file, for whichever duration is CURRENTLY
  // displayed - inputValue, not durationDays, so this updates on every drag tick, not just on
  // commit. Undefined (not null/[]) when the file isn't available yet/at all, or doesn't cover this
  // duration (past PRECOMPUTED_MAX_DURATION_DAYS) - displaySuggestions below falls back to the
  // server-fetched `suggestions` state in exactly that case, same as if this feature didn't exist.
  const clientSuggestions = useMemo(
    () => reconstructAllFlipSuggestions(precomputedData, inputValue),
    [precomputedData, inputValue]
  );
  // Same reconstruction, but for the COMMITTED duration - drives the effect below: only worth a
  // network request when the client-side file can't already answer for the duration that's about to
  // actually be fetched-for. Recomputed separately from clientSuggestions (which tracks the live drag
  // value) so dragging alone never triggers or skips a fetch - only committing does.
  const committedClientSuggestions = useMemo(
    () => reconstructAllFlipSuggestions(precomputedData, durationDays),
    [precomputedData, durationDays]
  );
  // What's actually shown in the table right now, and which duration it's actually FOR - prefers the
  // instant, client-reconstructed data whenever it covers the live (possibly mid-drag) duration, so
  // dragging updates the table with zero network round-trips; falls back to the slower server-fetched
  // path (and the committed duration, since that's the only duration `suggestions` can be for) only
  // when the precomputed file can't answer at all, e.g. past PRECOMPUTED_MAX_DURATION_DAYS.
  const displaySuggestions = clientSuggestions ?? suggestions;
  const displayDurationDays = clientSuggestions !== undefined ? inputValue : durationDays;
  // Gates the loading/empty states below on "do we have anything to show" rather than on isPending
  // directly - isPending only ever reflects the (now rarer) server-fetch fallback, and once
  // displaySuggestions has real rows there's nothing to wait on even if some earlier, now-irrelevant
  // fetch happens to still be in flight.
  const hasData = displaySuggestions.length > 0;

  useEffect(() => {
    if (committedClientSuggestions !== undefined) return; // already answerable locally - no request needed
    startTransition(async () => {
      setSuggestions(await fetchFlipSuggestions(durationDays));
      setPage(0);
    });
  }, [durationDays, committedClientSuggestions]);

  // Re-sort whenever the unit changes too: in divine mode a price/change column should order by
  // real value, not chaos value. Rows with no divine figure for the active sort column sort last.
  const sortedSuggestions = useMemo(
    () =>
      sortByKey(displaySuggestions, sort, (s, key) => {
        switch (key) {
          case "current":
            return activePrice(s.currentChaosValue, s.currentDivineValue, priceUnit);
          case "predicted":
            return activePrice(s.predictedChaosValue, s.predictedDivineValue, priceUnit);
          case "change":
            return activeRatio(s.avgGrowthRatio, s.avgGrowthRatioDivine, priceUnit);
        }
      }),
    [displaySuggestions, sort, priceUnit]
  );
  const normalizedSearch = searchText.trim().toLowerCase();
  const visibleSuggestions = sortedSuggestions.filter((s) => {
    // Undefined only when the row has no divine figure at all - don't exclude on a check we can't
    // actually evaluate, same philosophy as the sort/format helpers elsewhere in this unit.
    const activeCurrent = activePrice(s.currentChaosValue, s.currentDivineValue, priceUnit);
    const activeConf = activeConfidence(s.confidence, s.confidenceDivine, priceUnit);
    return (
      !hiddenCategories.has(s.filterCategory) &&
      (activeCurrent === undefined || isWithinRange(activeCurrent, currentRange)) &&
      s.name.toLowerCase().includes(normalizedSearch) &&
      (!faustusOnly || s.faustusTradeable) &&
      (activeConf === undefined || !hiddenConfidenceTiers.has(confidenceTier(activeConf)))
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

  function changePriceUnit(unit: PriceUnit) {
    setPriceUnit(unit);
    // Whatever the cost filter meant in the old unit doesn't carry over - a chaos max of 500 is
    // meaningless as a divine max. Divine mode specifically defaults to a minimum of 1: chaos-scale
    // noise (a fraction of a divine) otherwise clutters the table with items too cheap to matter at
    // divine granularity.
    setCurrentRange(unit === "divine" ? { min: 1 } : {});
    setPage(0);
  }

  function toggleFaustusOnly() {
    setFaustusOnly((prev) => !prev);
    setPage(0);
  }

  function toggleConfidenceTier(tier: ConfidenceTier) {
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
        <div className="flex flex-col gap-4">
          <CardTitle className="flex items-center gap-2">
            Flip suggestions
            {isPending && (
              <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading...
              </span>
            )}
          </CardTitle>
          <div className="flex flex-col gap-1.5">
            {/* Not htmlFor/id-linked to a <Label> - Base UI's Slider nests the real, focusable
                <input type="range"> inside its Thumb, not on the root div an id here would land on,
                so aria-label on the slider itself is the association that's actually guaranteed to
                work; the visible "Days ahead" text above it is there for sighted users either way. */}
            <Label>Days ahead</Label>
            {/* Exact entry, unbounded - dragging a slider can't reliably land on a specific value
                (especially past PRECOMPUTED_MAX_DURATION_DAYS, where the slider's own max is just an
                arbitrary drag limit, not a real ceiling). Mirrors the slider's live drag value (see
                inputValue above) so it's never stale while dragging, and fetches directly on change
                when typed into, same as every other numeric "Days ahead" input in this app. */}
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
            {/* inputValue, not durationDays - so this appears/disappears live while dragging too,
                instead of waiting for release like the actual fetch does. */}
            {inputValue > PRECOMPUTED_MAX_DURATION_DAYS && (
              <p className="text-xs text-muted-foreground">
                Past {PRECOMPUTED_MAX_DURATION_DAYS} days - loads can be slower.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Prices in</Label>
            <Tabs value={priceUnit} onValueChange={(value) => changePriceUnit(value as PriceUnit)}>
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
            Warning: It is Day-{currentDay} of the current league - the economy has largely settled by this point, so
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
          <NumericRangeFilter
            key={priceUnit}
            label={`cost (${priceUnitLabel(priceUnit)})`}
            onChange={changeCurrentRange}
            initialMin={priceUnit === "divine" ? 1 : undefined}
          />
          <Badge
            variant={faustusOnly ? "default" : "outline"}
            role="button"
            tabIndex={0}
            onClick={toggleFaustusOnly}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleFaustusOnly();
              }
            }}
            className="h-8 cursor-pointer select-none px-3"
            title="Show only currencies GGG's Currency Exchange (Faustus) can price - the default sort otherwise buries these on some far-off page"
          >
            Exchange price available
          </Badge>
        </div>
        {!hasData && isPending && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">Loading flip suggestions...</p>
          </div>
        )}
        {!hasData && !isPending && (
          <p className="text-sm text-muted-foreground">No historical matches found for current live prices yet.</p>
        )}
        {hasData && (
          <MobileSortControl
            options={[
              { key: "current", label: `Current (${priceUnitLabel(priceUnit)})` },
              { key: "predicted", label: `Predicted (${priceUnitLabel(priceUnit)})` },
              { key: "change", label: "Change" },
            ]}
            sort={sort}
            onSort={handleSort}
          />
        )}
        {hasData && (
          // -mx-4 cancels CardContent's own px-4, so these rows bleed out to the Card's edge
          // instead of sitting doubly-inset (Card's padding + the card's own) - only Dashboard's
          // outer p-2 remains as the gap to the actual screen edge on mobile.
          <div className="-mx-4 flex flex-col gap-2 sm:hidden">
            {pagedSuggestions.map((s) => (
              <ItemHistoryCard
                key={`${s.category}-${s.name}`}
                displayName={s.name}
                category={s.category}
                historyName={s.historyName}
                variant={s.variant}
                currentDay={currentDay}
                targetDay={currentDay + displayDurationDays}
                currentValue={activePrice(s.currentChaosValue, s.currentDivineValue, priceUnit)}
                predictedValue={activePrice(s.predictedChaosValue, s.predictedDivineValue, priceUnit)}
                fetchPredictedCurve
                priceUnit={priceUnit}
                fields={[
                  {
                    label: "Confidence",
                    value: (
                      <ConfidenceBadge
                        score={activeConfidence(s.confidence, s.confidenceDivine, priceUnit)}
                        upFraction={priceUnit === "chaos" ? s.upFraction : s.upFractionDivine}
                        leagueCount={priceUnit === "chaos" ? s.leagueCount : s.leagueCountDivine}
                        forecastSpread={priceUnit === "chaos" ? s.forecastSpread : undefined}
                      />
                    ),
                    emphasized: true,
                  },
                  { label: "Category", value: humanizeCategoryName(s.filterCategory) },
                  {
                    label: "Exchange",
                    value: s.faustusTradeable ? <FaustusPriceButton name={s.name} priceUnit={priceUnit} /> : "—",
                  },
                ]}
                rightFields={[
                  { label: `Current (${priceUnitLabel(priceUnit)})`, value: formatPriceValue(s.currentChaosValue, s.currentDivineValue, priceUnit) },
                  { label: `Predicted (${priceUnitLabel(priceUnit)})`, value: formatPriceValue(s.predictedChaosValue, s.predictedDivineValue, priceUnit) },
                  {
                    label: "Change",
                    value: formatPercentChange(s.avgGrowthRatio, s.avgGrowthRatioDivine, priceUnit),
                    emphasized: true,
                  },
                ]}
              />
            ))}
          </div>
        )}
        {hasData && (
          // Keyed on suggestions.length, not pagedSuggestions.length - the header (and the
          // Confidence column's tier filter it carries) must stay visible even when every row is
          // currently filtered out, or there'd be no way to re-enable a hidden tier once all three
          // are off and the table disappears out from under the controls that could undo it.
          <Table className="hidden sm:table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px] sm:w-[200px] lg:w-[280px]">Item</TableHead>
                {/* Category/Exchange Price are dropped below `sm` - mobile keeps the actual prices
                    (Current/Predicted) alongside Change/Confidence, same reasoning as the
                    mirage-simulator table below. The full set is always one tap away: expanding a
                    row's chart doesn't lose anything, it just isn't visible in the row itself. */}
                <TableHead className="hidden text-center sm:table-cell">Category</TableHead>
                <SortableHeader
                  label={`Current (${priceUnitLabel(priceUnit)})`}
                  sortKey="current"
                  sort={sort}
                  onSort={handleSort}
                />
                <TableHead className="hidden text-center sm:table-cell">Exchange Price</TableHead>
                <SortableHeader
                  label={`Predicted (${priceUnitLabel(priceUnit)})`}
                  sortKey="predicted"
                  sort={sort}
                  onSort={handleSort}
                />
                <SortableHeader label="Change" sortKey="change" sort={sort} onSort={handleSort} />
                <TableHead>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-muted-foreground">Confidence</span>
                    <ConfidenceTierFilter hidden={hiddenConfidenceTiers} onToggle={toggleConfidenceTier} />
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedSuggestions.map((s) => (
                <ItemHistoryRow
                  key={`${s.category}-${s.name}`}
                  displayName={s.name}
                  category={s.category}
                  historyName={s.historyName}
                  variant={s.variant}
                  currentDay={currentDay}
                  targetDay={currentDay + displayDurationDays}
                  currentValue={activePrice(s.currentChaosValue, s.currentDivineValue, priceUnit)}
                  predictedValue={activePrice(s.predictedChaosValue, s.predictedDivineValue, priceUnit)}
                  fetchPredictedCurve
                  priceUnit={priceUnit}
                  colSpan={7}
                >
                  <TableCell className="hidden sm:table-cell">
                    <div className="flex justify-center">
                      <Badge variant="secondary">{humanizeCategoryName(s.filterCategory)}</Badge>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPriceValue(s.currentChaosValue, s.currentDivineValue, priceUnit)}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="flex justify-center">
                      {s.faustusTradeable ? (
                        <FaustusPriceButton name={s.name} priceUnit={priceUnit} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPriceValue(s.predictedChaosValue, s.predictedDivineValue, priceUnit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPercentChange(s.avgGrowthRatio, s.avgGrowthRatioDivine, priceUnit)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-center">
                      <ConfidenceBadge
                        score={activeConfidence(s.confidence, s.confidenceDivine, priceUnit)}
                        upFraction={priceUnit === "chaos" ? s.upFraction : s.upFractionDivine}
                        leagueCount={priceUnit === "chaos" ? s.leagueCount : s.leagueCountDivine}
                        forecastSpread={priceUnit === "chaos" ? s.forecastSpread : undefined}
                      />
                    </div>
                  </TableCell>
                </ItemHistoryRow>
              ))}
            </TableBody>
          </Table>
        )}
        {hasData && visibleSuggestions.length === 0 && (
          <p className="text-sm text-muted-foreground">No suggestions match the current filters.</p>
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
