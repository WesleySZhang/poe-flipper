# TODO

Known gaps and ideas, so they don't get lost. Not a schedule or a promise. Open items are roughly
ordered by importance.

## At a glance

| # | Item | Status |
| --- | --- | --- |
| 1 | [League tester has no mobile layout](#1-league-tester-has-no-mobile-layout) | Open |
| 2 | [New items and categories: manual follow-ups](#2-new-items-and-categories-manual-follow-ups) | Open (small) |
| 3 | [A missed day of price history is lost for good](#3-a-missed-day-of-price-history-is-lost-for-good) | Open |
| 4 | [Cache the predictions file at the CDN](#4-cache-the-predictions-file-at-the-cdn) | Open |
| 5 | [Predict further than 30 days ahead?](#5-predict-further-than-30-days-ahead) | Undecided |
| 6 | [Live price vs history for items with several poe.ninja lines](#6-live-price-vs-history-for-items-with-several-poeninja-lines) | Undecided |
| 7 | [Holes in past-league history](#7-holes-in-past-league-history) | Open |
| 8 | [Small follow-ups](#8-small-follow-ups) | Open |
| – | [Done](#done) | – |

---

## 1. League tester has no mobile layout

Every other table switches to stacked cards on a phone (`components/item-history-card.tsx`), with a
"Sort by" control and the confidence filter above them. The league tester still renders a plain
table that scrolls sideways.

**Fix:** give it its own `fields` / `rightFields` for `ItemHistoryCard`, the way the other panels do.
The shared card and expand logic should need no changes.

## 2. New items and categories: manual follow-ups

A daily job now picks up new poe.ninja categories, Currency Exchange names and divination cards, and
opens a PR (see Done, and the README's "New items and categories"). Its first run added 7 categories
and 75 exchange names. What it can't do, and is still open from that run:

- **Place the new categories in the category filter** (`lib/category-reliability.ts`). Corpse, Ducat,
  Enshrouding Crystal, Forbidden Jewel, Astrolabe, Scrying Orb and Flask currently sit in "Etc.",
  hidden by default.
- **Gold cost for Scrap Metal** in `lib/faustus-gold.ts`.
- **Categories poe.ninja no longer lists** (Prophecy, Seed, Helmet Enchant, Watchstone, Unique Idol,
  Kalguuran Rune, Coffin) are still requested. Harmless, since empty categories are skipped after the
  first daily snapshot, but they could be removed once no past-league history needs them.

## 3. A missed day of price history is lost for good

`scripts/precompute-price-history.ts` only writes today's row. If a run is missed (an outage, a
poe.ninja failure), that day is simply absent from the current league's CSVs.

**Fix:**

1. **Detect:** before writing today's row, check whether the previous days are present.
2. **Backfill:** rebuild any missed day still within poe.ninja's 7-day sparkline, the same way
   `scripts/backfill-current-league-history.ts` does, tagged `Confidence=Medium`. Log anything older
   as unrecoverable.

Scheduled runs are routinely hours late, but they have landed every day so far; the app already
copes with the delay (see Done).

## 4. Cache the predictions file at the CDN

`/api/flip-suggestions/precomputed` caches its gzipped response in memory, but sends no
`Cache-Control` header, so every cold server instance still does the work. The file changes once a
day.

- Add `Cache-Control: public, s-maxage=120, stale-while-revalidate=...` so Vercel's CDN serves
  repeats without invoking the function. Available on the free plan.
- Vercel won't cache a response over **10 MB**; today's is about 5.4 MB gzipped (see item 5).
- This saves server work, not visitor download size.

## 5. Predict further than 30 days ahead?

Raising `CURVE_MAX_DURATION_DAYS` would extend the instant slider range and the detailed forecast
line. Measured on the real file:

| Days ahead | Raw size | Gzipped | Job time |
| --- | --- | --- | --- |
| 30 (today) | 20.6 MB | 5.4 MB | ~31 s |
| 60 | ~39 MB | ~10 MB | ~60 s |
| 90 | ~57 MB | ~15 MB | ~90 s |

The job time is free. The cost is that every visitor downloads the whole file: 60 days sits at the
CDN's 10 MB limit, 90 is over it, and a bigger file hurts on mobile. If this goes ahead, ship only
the days actually needed instead of the whole file.

## 6. Live price vs history for items with several poe.ninja lines

Base types (e.g. Dragonscale Doublet) have one poe.ninja line per item level or influence, all under
one name. The live price takes the **first** line (1.8c); past-league and current-league history
**average** the day's lines (~1.4c). The chart's history line and forecast start at different
prices, and the model predicts from a price that doesn't match what it was trained on.

**Option:** average the lines for the live price too. That would change the starting price, and so
the forecast and ranking, for every affected item (mostly base types). Needs a decision.

## 7. Holes in past-league history

Some items have gaps in a past league's data. The Last One Standing has no Keepers prices on days
78–93, and its Mirage history stops at day 34. The daily job now fills the resulting missing
forecast days (see Done), but:

- the live calculation path (used past 30 days, or when the file is missing) doesn't fill;
- training data keeps the holes;
- a Mirage series ending at day 34 for a card is suspicious and worth checking against the raw
  export and the ingest's outlier filters.

**Option:** interpolate short gaps (say up to 20 days) within a league at ingest time.

## 8. Small follow-ups

- **Slider when a day has no precomputed data.** On the detail page and main table, dragging to a
  day the file doesn't cover (day 30 when the file is a day old, or past 30) freezes the chart and
  table on the previous value until release, then waits for a live calculation.

---

## Done

- **Per-item detail page** (`app/item/[category]/[key]/`). Linked from every item name and from
  search. Slider, big chart, overview, historical performance, momentum, Currency Exchange and card
  flip data, poewiki and poe.ninja links.
- **Mobile support** for Flip Predictions, Mirage simulator, Currency Exchange Flip and Divination
  Card Flips: stacked cards, "Sort by" control, confidence/liquidity filter, larger chart text, and
  tap-to-show tooltips on the chart. (The league tester is item 1.)
- **Slow chart loading and app-wide freezes.** Added caching and request sharing for the heavy
  calculations, cached serialized responses, and removed the live forecast-curve fallback, which
  recomputed the whole catalog 30 times and could stall the app for over a minute.
- **Global search** in the header, over everything poe.ninja prices, linking to detail pages.
- **Fewer poe.ninja calls.** The daily job publishes `prices.json`; the detail page, search and
  Mirage simulator read it instead of poe.ninja.
- **Every item predicts all 30 days.** Missing days are filled with marked, lower-confidence
  estimates (`lib/horizon-fill.ts`).
- **Late daily runs no longer degrade the app.** GitHub starts the scheduled job hours late; the app
  used to reject the day-old file until then, losing the detailed forecast line and the instant
  slider. It now shifts a file up to 2 days old to today (`alignPrecomputedToDay`).
- **New items and categories are picked up automatically.** A daily job
  (`.github/workflows/check-new-items.yml`) adds new poe.ninja categories (read from poe.ninja's own
  site config), new Currency Exchange names and regenerated divination cards, and opens a PR listing
  what needs a human.
- **Retraining runs from a workflow.** After choosing a finished league to train on, run "Retrain
  model" (`.github/workflows/retrain-model.yml`): it downloads the history, rebuilds the DB,
  retrains, checks parity and the Mirage backtest, and opens a PR comparing validation scores with
  the previous model.
- **Currency Exchange Flip can buy with one currency and sell for the other.** It considers an
  item's Chaos and Divine markets separately and takes the best of the four routes, shown under
  each price (e.g. Stacked Deck: buy for 6c on Chaos, sell for ~7.6c on Divine). This also replaced
  converting every Divine price from chaos (the old item 6). Divination Card Flips doesn't pick a
  route per leg the same way - its buy/sell prices are unchanged.
- **Current-league history** for migrated types (cards, scarabs, ...) now shows on the chart, and
  same-day duplicate rows are averaged like past leagues.
