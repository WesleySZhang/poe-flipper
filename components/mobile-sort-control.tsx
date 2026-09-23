"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SortState } from "@/lib/sort";

export interface MobileSortOption<K extends string> {
  key: K;
  label: string;
}

/**
 * Mobile equivalent of SortableHeader - the desktop <table> disappears below sm: (replaced by the
 * card list), taking every column header's click-to-sort affordance with it. This renders as one
 * row above the card list: a <Select> to pick the sort column, plus a direction button styled like
 * SortableHeader's own icon (ArrowUp/ArrowDown - no ChevronsUpDown "unsorted" state needed here,
 * since a key is always selected). Calls the exact same onSort(key) callback each panel already
 * passes to SortableHeader, so picking the already-active key from the dropdown flips direction
 * (via lib/sort.ts's toggleSort) exactly like clicking an active column header does on desktop.
 */
export function MobileSortControl<K extends string>({
  options,
  sort,
  onSort,
}: {
  options: MobileSortOption<K>[];
  sort: SortState<K>;
  onSort: (key: K) => void;
}) {
  return (
    <div className="flex items-center gap-2 sm:hidden">
      <span className="text-xs text-muted-foreground">Sort by</span>
      <Select value={sort.key} onValueChange={(value) => onSort(value as K)}>
        <SelectTrigger className="h-8 flex-1" size="sm">
          {/* SelectValue renders the raw string value by default (it only auto-resolves a label
              for {value,label}-shaped item objects) - our items are plain string keys, so map back
              to the matching option's label ourselves. */}
          <SelectValue>{(value: K) => options.find((o) => o.key === value)?.label ?? value}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* Toggling direction re-sorts by the already-active key, same toggleSort() flip a second
          click on a desktop SortableHeader triggers. */}
      <button
        type="button"
        onClick={() => onSort(sort.key)}
        title={sort.direction === "asc" ? "Sorted ascending - tap to sort descending" : "Sorted descending - tap to sort ascending"}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-input text-foreground"
      >
        {sort.direction === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
      </button>
    </div>
  );
}
