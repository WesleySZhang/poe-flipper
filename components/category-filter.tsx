"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  isReliableCategory,
  isUniqueCategory,
  RELIABLE_CATEGORIES_ORDERED,
  UNIQUE_CATEGORIES_ORDERED,
  humanizeCategoryName,
} from "@/lib/category-reliability";

function BadgeRow({
  categories,
  selected,
  onToggle,
}: {
  categories: string[];
  selected: Set<string>;
  onToggle: (category: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {categories.map((category) => (
        <Badge
          key={category}
          variant={selected.has(category) ? "default" : "outline"}
          role="button"
          tabIndex={0}
          onClick={() => onToggle(category)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle(category);
            }
          }}
          className="cursor-pointer select-none"
        >
          {humanizeCategoryName(category)}
        </Badge>
      ))}
    </div>
  );
}

function BulkActions({
  categories,
  onSelectAll,
  onDeselectAll,
}: {
  categories: string[];
  onSelectAll: (categories: string[]) => void;
  onDeselectAll: (categories: string[]) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-xs"
        onClick={() => onSelectAll(categories)}
      >
        Select all
      </Button>
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-xs"
        onClick={() => onDeselectAll(categories)}
      >
        Deselect all
      </Button>
    </div>
  );
}

export function CategoryFilter({
  categories,
  selected,
  onToggle,
  onSelectAll,
  onDeselectAll,
}: {
  categories: string[];
  selected: Set<string>;
  onToggle: (category: string) => void;
  onSelectAll: (categories: string[]) => void;
  onDeselectAll: (categories: string[]) => void;
}) {
  const [unreliableOpen, setUnreliableOpen] = useState(false);

  if (categories.length === 0) return null;

  const reliable = RELIABLE_CATEGORIES_ORDERED.filter((c) => categories.includes(c));
  const uniques = UNIQUE_CATEGORIES_ORDERED.filter((c) => categories.includes(c));
  const unreliable = categories.filter((c) => !isReliableCategory(c) && !isUniqueCategory(c));

  return (
    <div className="flex flex-col gap-3">
      {reliable.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Categories</p>
            <BulkActions categories={reliable} onSelectAll={onSelectAll} onDeselectAll={onDeselectAll} />
          </div>
          <BadgeRow categories={reliable} selected={selected} onToggle={onToggle} />
        </div>
      )}
      {uniques.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium">Meta items</p>
              <p className="text-xs text-muted-foreground">
                Disclaimer: these values are league-meta dependent.
              </p>
            </div>
            <BulkActions categories={uniques} onSelectAll={onSelectAll} onDeselectAll={onDeselectAll} />
          </div>
          <BadgeRow categories={uniques} selected={selected} onToggle={onToggle} />
        </div>
      )}
      {unreliable.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setUnreliableOpen((open) => !open)}
          >
            {unreliableOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            Etc.
          </button>
          {unreliableOpen && (
            <>
              <div className="flex justify-end">
                <BulkActions categories={unreliable} onSelectAll={onSelectAll} onDeselectAll={onDeselectAll} />
              </div>
              <BadgeRow categories={unreliable} selected={selected} onToggle={onToggle} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
