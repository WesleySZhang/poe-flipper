"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface KnownItemName {
  category: "currency" | "item";
  name: string;
  variant?: string;
  displayName: string;
}

const MAX_SUGGESTIONS = 20;

/**
 * Free-text search over every name this app has historical data for, that only ever resolves to an
 * exact (category, name[, variant]) triple - the prediction API matches on that triple exactly, so
 * a free-typed guess that's off by a variant or a word would otherwise just silently 404. Typing
 * after a selection clears it, so a stale selection can never be predicted against different text.
 */
export function ItemNameCombobox({
  names,
  selected,
  onSelect,
}: {
  names: KnownItemName[];
  selected: KnownItemName | null;
  onSelect: (name: KnownItemName | null) => void;
}) {
  const [query, setQuery] = useState(selected?.displayName ?? "");
  const [isOpen, setIsOpen] = useState(false);

  const normalizedQuery = query.trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (!normalizedQuery || selected) return [];
    return names.filter((n) => n.displayName.toLowerCase().includes(normalizedQuery)).slice(0, MAX_SUGGESTIONS);
  }, [names, normalizedQuery, selected]);

  function handleChange(text: string) {
    setQuery(text);
    setIsOpen(true);
    if (selected) onSelect(null);
  }

  function handlePick(name: KnownItemName) {
    setQuery(name.displayName);
    setIsOpen(false);
    onSelect(name);
  }

  return (
    <div className="relative flex flex-col gap-1.5">
      <Label htmlFor="item-name">Item</Label>
      <Input
        id="item-name"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setIsOpen(true)}
        onBlur={() => {
          // Delayed so a click on a suggestion (which blurs the input first) still registers.
          setTimeout(() => setIsOpen(false), 150);
        }}
        placeholder="Search for an item or currency..."
        className="w-72"
        autoComplete="off"
      />
      {isOpen && suggestions.length > 0 && (
        <ul className="absolute top-full z-10 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border bg-popover py-1 text-sm shadow-md">
          {suggestions.map((n) => (
            <li key={`${n.category}-${n.name}-${n.variant ?? ""}`}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handlePick(n)}
                className="w-full px-3 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
              >
                {n.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}
      {isOpen && normalizedQuery && !selected && suggestions.length === 0 && (
        <div className="absolute top-full z-10 mt-1 w-72 rounded-md border bg-popover px-3 py-1.5 text-sm text-muted-foreground shadow-md">
          No matches - no historical data for that name.
        </div>
      )}
    </div>
  );
}
