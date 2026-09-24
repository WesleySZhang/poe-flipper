"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { humanizeCategoryName } from "@/lib/category-reliability";
import { itemDetailUrlKey } from "@/lib/poe-ninja";
import type { ItemSearchResult } from "@/lib/item-search";

const DEBOUNCE_MS = 150;

/**
 * Header search box: type an item/currency name, pick a suggestion, land on its detail page
 * (app/item/[category]/[key]/page.tsx). Suggestions come from /api/item-search (everything poe.ninja
 * currently prices, not just items with a forecast). Rendered twice by the header, one per variant:
 * "desktop" is the inline input (sm+); "mobile" is an icon that opens the input as a full-width
 * overlay, since the phone nav row has no room. Each instance keeps its own state.
 */
export function GlobalSearch({ variant }: { variant: "desktop" | "mobile" }) {
  const isMobile = variant === "mobile";
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ItemSearchResult[]>([]);
  const [settledQuery, setSettledQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);

  const trimmed = query.trim();
  // Results for a query that's since changed are stale - hide them rather than flash old matches.
  const visible = open && trimmed !== "" && settledQuery === trimmed ? results : [];

  useEffect(() => {
    if (!trimmed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/item-search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then((res) => (res.ok ? (res.json() as Promise<ItemSearchResult[]>) : []))
        .then((data) => {
          setResults(data);
          setSettledQuery(trimmed);
          setActive(0);
        })
        .catch(() => {}); // aborted or offline - the next keystroke retries
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  function close() {
    setOpen(false);
    setMobileOpen(false);
  }

  function go(result: ItemSearchResult) {
    router.push(`/item/${result.category}/${itemDetailUrlKey(result.name, result.variant)}`);
    setQuery("");
    setResults([]);
    setSettledQuery("");
    close();
    inputRef.current?.blur();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (visible.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % visible.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + visible.length) % visible.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(visible[active] ?? visible[0]);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size="icon-sm"
        aria-label="Search items"
        className={cn("sm:hidden", !isMobile && "hidden")}
        onClick={() => {
          setMobileOpen(true);
          setOpen(true);
          // Not yet rendered visible this tick - focus after the overlay's classes apply.
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <Search />
      </Button>
      <div
        className={cn(
          isMobile
            ? mobileOpen
              ? "fixed inset-x-4 top-4 z-50 flex items-center gap-2 rounded-lg bg-background sm:hidden"
              : "hidden"
            : "relative hidden w-56 sm:block lg:w-72"
        )}
      >
        <div className="relative w-full">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={visible.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={visible.length > 0 ? `${listId}-${active}` : undefined}
            aria-label="Search items"
            placeholder="Search items..."
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={handleKeyDown}
            className="pl-8"
          />
          {open && trimmed !== "" && (
            <ul
              id={listId}
              role="listbox"
              // mousedown (not click) is where focus would leave the input and close this list before
              // the click lands, so it's cancelled here and the click handler below does the work.
              onMouseDown={(e) => e.preventDefault()}
              className="absolute top-full right-0 left-0 z-50 mt-1 max-h-80 sm:right-auto sm:w-[38rem] sm:max-w-[calc(100vw-3rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {visible.map((r, i) => (
                <li
                  key={`${r.category}:${r.name}:${r.variant ?? ""}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r)}
                  className={cn(
                    "flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-sm",
                    i === active && "bg-muted"
                  )}
                >
                  <span className="min-w-0 break-words">{r.displayName}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{humanizeCategoryName(r.type)}</span>
                </li>
              ))}
              {settledQuery === trimmed && results.length === 0 && (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">No matches</li>
              )}
            </ul>
          )}
        </div>
        {mobileOpen && (
          <Button variant="ghost" size="icon-sm" aria-label="Close search" className="sm:hidden" onClick={close}>
            <X />
          </Button>
        )}
      </div>
    </>
  );
}
