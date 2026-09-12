"use client";

import { useState } from "react";
import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface NumericRange {
  min?: number;
  max?: number;
}

export function isWithinRange(value: number, range: NumericRange): boolean {
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/** A small filter-icon button next to a table column header that opens a min/max range popup. */
export function NumericRangeFilter({
  label,
  range,
  onChange,
}: {
  label: string;
  range: NumericRange;
  onChange: (range: NumericRange) => void;
}) {
  const [minText, setMinText] = useState(range.min?.toString() ?? "");
  const [maxText, setMaxText] = useState(range.max?.toString() ?? "");
  const isActive = range.min !== undefined || range.max !== undefined;

  function apply() {
    const min = minText.trim() === "" ? undefined : Number(minText);
    const max = maxText.trim() === "" ? undefined : Number(maxText);
    onChange({
      min: min !== undefined && Number.isFinite(min) ? min : undefined,
      max: max !== undefined && Number.isFinite(max) ? max : undefined,
    });
  }

  function clear() {
    setMinText("");
    setMaxText("");
    onChange({});
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={isActive ? "text-foreground" : "text-muted-foreground"}
            aria-label={`Filter ${label}`}
          />
        }
      >
        <Filter className="size-3" fill={isActive ? "currentColor" : "none"} />
      </PopoverTrigger>
      <PopoverContent className="w-56" align="start">
        <p className="text-xs font-medium">Filter {label}</p>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${label}-min`} className="text-xs text-muted-foreground">
              Min
            </Label>
            <Input
              id={`${label}-min`}
              type="number"
              value={minText}
              onChange={(e) => setMinText(e.target.value)}
              className="h-8 w-24"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${label}-max`} className="text-xs text-muted-foreground">
              Max
            </Label>
            <Input
              id={`${label}-max`}
              type="number"
              value={maxText}
              onChange={(e) => setMaxText(e.target.value)}
              className="h-8 w-24"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
          <Button type="button" size="sm" onClick={apply}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
