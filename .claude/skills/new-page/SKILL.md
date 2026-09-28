---
name: new-page
description: Use when adding a new page to this app, or reworking a page panel's layout - the route/nav wiring and the panel layout conventions (one title, one controls row, Chaos/Divine toggle, loading state, mobile cards).
---

# Add a page (or rework a panel's layout)

## Wiring

1. `app/<route>/page.tsx` - thin server component, same shape as `app/dust-value/page.tsx`:
   `<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">`, `<AppHeader title="..." />`,
   then the panel. The login gate (`proxy.ts` matcher) covers new routes on its own.
2. Nav link: add `{ href, label }` to `components/app-header.tsx` - the main list, or the Testing
   dropdown list for test tools.
3. The panel: `components/<name>-panel.tsx` (`"use client"`), data from an `app/api/<name>/route.ts`.
4. README: add the page to the pages table and give it a section; list new files in the file tables.

## Panel layout (owner's rules, 2026-09-28)

- **One title.** The page title is `AppHeader`'s `<h1>`. The panel is `<Card><CardContent>` with
  **no `CardHeader`/`CardTitle`** - a second, smaller title repeats the page name and wastes a row.
- **One controls row** at the top of `CardContent`: search, range filters, toggles and the
  Chaos/Divine tabs share a `flex flex-wrap items-end gap-4` row. Put the price tabs last with
  `ml-auto` so they sit at the right on desktop and wrap on a phone. Don't stack a control above
  the search.
- **Chaos/Divine tabs have no label** ("Prices in" was removed everywhere) - the tab text says it.
- **Small notes stay small**: a warning or caveat goes beside the controls in `text-[11px]`, with the
  full sentence in `title`, not as a full-width paragraph (see the Currency Exchange Flip day warning).
- **No caption lines** restating what the table shows. AGENTS.md's short-text rule applies.
- **Loading**: a centred `Loader2` block while the first fetch runs (see `dust-value-panel.tsx`),
  or a small inline spinner beside the controls for a refetch.
- **Tables**: reuse `ItemHistoryRow`/`ItemHistoryCard`, `SortableHeader`, `MobileSortControl`,
  `Pagination`, `LiquidityTierFilter` (see AGENTS.md: shared components first). Desktop table is
  `hidden sm:table`; the mobile card list is `sm:hidden` with `-mx-4`.

## Check

Run the `verify-ui` skill at 1280px and 390px: no duplicate title, the controls row fits (wraps on
a phone without horizontal scroll), the nav link is highlighted on the new page.
