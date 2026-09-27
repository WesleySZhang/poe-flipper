# TODO

Known gaps and ideas, so they don't get lost. Not a schedule or a promise. Open items are roughly
ordered by importance.

## At a glance

| # | Item | Status |
| --- | --- | --- |
| 1 | [League tester has no mobile layout](#1-league-tester-has-no-mobile-layout) | Open |
| 2 | [New items and categories: manual follow-ups](#2-new-items-and-categories-manual-follow-ups) | Open (small) |
| 3 | [Live price vs history for items with several poe.ninja lines](#3-live-price-vs-history-for-items-with-several-poeninja-lines) | Undecided |
| 4 | [Holes in past-league history](#4-holes-in-past-league-history) | Open |
| 5 | [Small follow-ups](#5-small-follow-ups) | Open |
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

## 3. Live price vs history for items with several poe.ninja lines

Base types (e.g. Dragonscale Doublet) have one poe.ninja line per item level or influence, all under
one name. The live price takes the **first** line (1.8c); past-league and current-league history
**average** the day's lines (~1.4c). The chart's history line and forecast start at different
prices, and the model predicts from a price that doesn't match what it was trained on.

**Option:** average the lines for the live price too. That would change the starting price, and so
the forecast and ranking, for every affected item (mostly base types). Needs a decision.

## 4. Holes in past-league history

Some items have gaps in a past league's data. The Last One Standing has no Keepers prices on days
78–93, and its Mirage history stops at day 34. The daily job now fills the resulting missing
forecast days (see Done), but:

- the live calculation path (used past 30 days, or when the file is missing) doesn't fill;
- training data keeps the holes;
- a Mirage series ending at day 34 for a card is suspicious and worth checking against the raw
  export and the ingest's outlier filters.

**Option:** interpolate short gaps (say up to 20 days) within a league at ingest time.

## 5. Small follow-ups

- **Dust Value gaps.** Foulborn (mutated) uniques are left out until it's confirmed they give their
  base unique's dust; quality (poedb says +1% per point, the game +2%) and corruption/influence
  (+50% each) aren't counted. poedb lists unique maps too; unchecked whether Kingsmarch accepts them.
- **Slider when a day has no precomputed data.** On the detail page and main table, dragging to a
  day the file doesn't cover (day 30 when the file is a day old, or past 30) freezes the chart and
  table on the previous value until release, then waits for a live calculation.

---

## Done

- **Dust Value page** (`/dust-value`). Uniques ranked by Thaumaturgic Dust per chaos for Kingsmarch
  disenchanting: poedb's dust values (generated into `lib/disenchant-values.ts`) against poe.ninja's
  cheapest trusted line per unique, with an item-level input and the usual price, confidence and
  Chaos/Divine controls.
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
- **Divination Card Flips have an Instant buy button.** Off by default; on, Cost/Profit %/Profit use
  the stack bought off sell orders (the top of the card's hour range on the exchange × stack size),
  in both price modes, on the table and the item page. Cards that never had a full stack listed that
  hour are hidden while it's on. Min/Max's hover shows the hour's listed stock.
- **Divination Card Flips' Divine mode buys the cards with divines.** Each card at its own Divine
  market price (hour midpoint) instead of its chaos price converted; cards with no Divine market that
  hour are hidden in Divine mode. The reward stays at its chaos price, converted.
- **A missed day of price history is rebuilt automatically.** Before writing today's row, the daily
  job reads the last two weeks of files and rebuilds any of the last 6 days with no rows from
  poe.ninja's sparkline (Confidence=Medium). Older holes can't be rebuilt and show as a warning in
  the Actions run for a week. Tested on real days: stash items came back exact (median error 0.0%);
  exchange-priced types within a median ~8-17% of the job's own noisier single readings.
- **The predictions file is cached at Vercel's CDN.** `/api/flip-suggestions/precomputed` sends
  `Cache-Control: public, s-maxage=120, stale-while-revalidate=600` (and `Vary: Accept-Encoding`),
  so repeats don't invoke the function. It's ~5.4 MB gzipped, under the 10 MB cache limit, and the
  site password still applies (Vercel runs proxy.ts before its cache).
- **Predict further than 30 days ahead: decided against, for now.** Raising it would sit right at
  or over the CDN's 10 MB response-cache limit (60 days ~10 MB gzipped, 90 days ~15 MB), and the
  model is only trained/validated up to a 30-day horizon anyway. Revisit only alongside shipping
  just the needed days instead of the whole file.
- **Retraining runs from a workflow.** After choosing a finished league to train on, run "Retrain
  model" (`.github/workflows/retrain-model.yml`): it downloads the history, rebuilds the DB,
  retrains, checks parity and the Mirage backtest, and opens a PR comparing validation scores with
  the previous model.
- **Currency Exchange Flip can buy with one currency and sell for the other.** It considers an
  item's Chaos and Divine markets separately and takes the best of the four routes, each price
  shown in its market's currency (e.g. Stacked Deck: buy 6.0c, sell 0.019d). This also replaced
  converting every Divine price from chaos (the old item 6). Divination Card Flips doesn't pick a
  route per leg the same way - its buy/sell prices are unchanged.
- **Current-league history** for migrated types (cards, scarabs, ...) now shows on the chart, and
  same-day duplicate rows are averaged like past leagues.
