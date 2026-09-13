"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

/** A live text filter - the list re-filters on every keystroke, no submit needed. */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search items...",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative w-full max-w-xs">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8"
      />
    </div>
  );
}
