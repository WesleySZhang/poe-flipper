"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface NumericRange {
  min?: number;
  max?: number;
}

export function isWithinRange(value: number, range: NumericRange): boolean {
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/**
 * Plain min/max text inputs that filter live as you type - sits with the rest of the panel's
 * controls rather than tucked behind an icon on the column header, so the active filter (and its
 * values) stays visible at a glance.
 */
export function NumericRangeFilter({
  label,
  onChange,
}: {
  label: string;
  onChange: (range: NumericRange) => void;
}) {
  const [minText, setMinText] = useState("");
  const [maxText, setMaxText] = useState("");

  function emit(min: string, max: string) {
    const parsedMin = min.trim() === "" ? undefined : Number(min);
    const parsedMax = max.trim() === "" ? undefined : Number(max);
    onChange({
      min: parsedMin !== undefined && Number.isFinite(parsedMin) ? parsedMin : undefined,
      max: parsedMax !== undefined && Number.isFinite(parsedMax) ? parsedMax : undefined,
    });
  }

  return (
    <div className="flex items-end gap-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${label}-min`}>Min {label}</Label>
        <Input
          id={`${label}-min`}
          type="number"
          placeholder="0"
          value={minText}
          onChange={(e) => {
            setMinText(e.target.value);
            emit(e.target.value, maxText);
          }}
          className="w-24"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${label}-max`}>Max {label}</Label>
        <Input
          id={`${label}-max`}
          type="number"
          placeholder="∞"
          value={maxText}
          onChange={(e) => {
            setMaxText(e.target.value);
            emit(minText, e.target.value);
          }}
          className="w-24"
        />
      </div>
    </div>
  );
}
