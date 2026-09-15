"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "cn";
import { TableHead } from "@/components/ui/table";
import type { SortState } from "@/lib/sort";

/** A numeric column header that doubles as its own sort button - click to sort by it, click again to flip direction. */
export function SortableHeader<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: React.ReactNode;
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  className?: string;
}) {
  const isActive = sort.key === sortKey;
  const Icon = isActive ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;

  return (
    <TableHead className={cn("text-right", className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          isActive ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
        <Icon className="size-3.5" />
      </button>
    </TableHead>
  );
}
