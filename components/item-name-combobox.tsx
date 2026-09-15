"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface KnownItemName {
  category: "currency" | "item";
  name: string;
  variant?: string;
  displayName: string;
}

const MAX_SUGGESTIONS = 50;

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (!normalizedQuery || selected) return [];
    const matches = names.filter((n) => n.displayName.toLowerCase().includes(normalizedQuery));
    // Plain alphabetical order buries an exact/prefix match under every longer name that happens to
    // sort earlier - e.g. "Foulborn Mageblood" (corrupted-implicit variant) sorts before the plain
    // "Mageblood" a search for "mageblood" is almost always actually after. Sort.() is stable, so
    // this only reorders the two buckets - alphabetical order survives within each.
    matches.sort((a, b) => {
      const aStarts = a.displayName.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
      const bStarts = b.displayName.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
      return aStarts - bStarts;
    });
    return matches.slice(0, MAX_SUGGESTIONS);
  }, [names, normalizedQuery, selected]);

  // The dropdown is portaled to <body> (see the render below) specifically to escape Card's
  // overflow-hidden (components/ui/card.tsx) - nested inside the card, a tall absolutely-positioned
  // list gets clipped to whatever vertical space is left in the card, which is what made the list
  // look "stuck at ~2 visible items" no matter how tall its own max-height was set. Once portaled out
  // to <body>, position has to be computed by hand (fixed, from the input's own bounding rect)
  // instead of relying on CSS "absolute; top: full" against a positioned ancestor - recomputed
  // whenever the dropdown opens/the list changes, and kept in sync with scrolling/resizing while open.
  useEffect(() => {
    if (!isOpen) return;
    function updateRect() {
      const el = inputRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setDropdownRect({ top: rect.bottom, left: rect.left, width: rect.width });
    }
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [isOpen, suggestions.length]);

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

  const showSuggestions = isOpen && suggestions.length > 0 && dropdownRect;
  const showEmpty = isOpen && normalizedQuery && !selected && suggestions.length === 0 && dropdownRect;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="item-name">Item</Label>
      <Input
        id="item-name"
        ref={inputRef}
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
      {showSuggestions &&
        createPortal(
          <ul
            style={{ top: dropdownRect.top, left: dropdownRect.left, width: dropdownRect.width }}
            className="fixed z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-md border bg-popover py-1 text-sm shadow-md"
          >
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
          </ul>,
          document.body
        )}
      {showEmpty &&
        createPortal(
          <div
            style={{ top: dropdownRect.top, left: dropdownRect.left, width: dropdownRect.width }}
            className="fixed z-50 mt-1 rounded-md border bg-popover px-3 py-1.5 text-sm text-muted-foreground shadow-md"
          >
            No matches - no historical data for that name.
          </div>,
          document.body
        )}
    </div>
  );
}
