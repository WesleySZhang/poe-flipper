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
| 6 | [Sold item tracker](#6-sold-item-tracker) | Researched, not started |
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
  base unique's dust; corruption/influence (+50% each) aren't counted. poedb lists unique maps too;
  unchecked whether Kingsmarch accepts them.
- **Dust formula: ×2000 or ×2500?** The page uses poedb's item-level multiplier (×2000 of the base
  value at ilvl 84). Another formula in circulation gives exactly 1.25× that from ilvl 68 up (×2500
  at 84) and a gentler slope below 68 (poedb bottoms out at 65). Settle it with one in-game
  disenchant of a unique with a known item level. The ranking doesn't change either way, only the
  dust shown. Also unconfirmed: quality is counted at +2% per point (the in-game text; poedb's
  formula says +1%), with every item assumed at 20%.
- **poe.ninja's single-request price feed, on hold.** `/poe1/api/economy/current/dense/overviews`
  returns every category in one response (~366 KB, ~0.3 s) instead of the ~48 requests the app and
  daily job make. Not a drop-in: lines carry only name, variant, price and 7-day graph (no seller
  count, links, detailsId or base type; variants include the base type and "6L"), and its currency
  and card prices differ from the exchange-based ones the app uses (71 of 213 cards, 77 of 100
  currencies on 2026-09-28). Unique and gem prices match. Candidate use: the daily job's stash-type
  fetches.
- **Slider when a day has no precomputed data.** On the detail page and main table, dragging to a
  day the file doesn't cover (day 30 when the file is a day old, or past 30) freezes the chart and
  table on the previous value until release, then waits for a live calculation.

## 6. Sold item tracker

**Goal:** list items that sold on the trade site: the item and its mods, price, when it sold and how
long it was listed. A job polls the trade site every few minutes, and a listing that disappears is
assumed sold.

**Verdict: feasible for a small watchlist, not for the whole market.** The limit is a few dozen
watched searches or a few hundred listings, at 5-30 minute resolution. Findings (probed 2026-09-27):

- **The official route is closed.** GGG's public stash API (`service:psapi`, the feed poe.ninja
  uses, with a 5-minute delay) reports every stash change. That's how you'd see removals across the
  whole market. But GGG's developer docs say "We are currently unable to process new applications."
- **The trade site API is undocumented.** GGG's docs say reverse-engineering endpoints outside their
  documentation is against the Terms of Use (7i), and they revoke access for exceeding rate limits.
  Price-check tools use it at a user's click. A server polling around the clock is a heavier pattern
  and a real risk, though no login is involved. Use a descriptive `User-Agent` either way.
- **Per-IP limits** (from the response headers):

  | Endpoint | Limits (requests:seconds) | Sustained |
  | --- | --- | --- |
  | Search | `5:10`, `15:60`, `30:300`, `600:21600` | ~100/hour |
  | Fetch | `12:4`, `16:12`, `50:300`, `1000:21600` | ~167/hour, 10 listings each |

  Going over a limit locks the IP out for the penalty in the header (up to 1 hour).
- **What the API gives:**
  - A search returns at most 100 listing ids, cheapest first, plus a `total`. Kaom's Heart had 3,448
    listings.
  - A fetch returns each listing:
    - the item: full mods, ilvl, sockets, corruption;
    - `price`: amount, currency, `~b/o` or `~price`;
    - account name and whether they're online;
    - stash tab name and position;
    - `indexed`: when it was listed or last changed.
  - The listing id equals the item's own id, so a repriced item keeps its id.
  - **A fetch of a listing that's gone returns `null`** in its slot, and fetch doesn't need the
    search id. That makes it a cheap way to check whether a listing is still up, 10 per request.
- **Traps:**
  - *Gone isn't sold.* A listing also disappears when the seller moves the item to a private tab,
    removes its price or uses it. Treat an id as sold only once it's been missing for 2+ checks
    and hasn't reappeared.
  - *Offline sellers.* Search with status `any`. With `online`, a seller logging off looks like a
    sale.
  - *Bait.* The cheapest listings are often weeks-old 1c bait from offline accounts (Kaom's Heart:
    1c listings from August). Set a minimum price near the market price, e.g. half poe.ninja's.
  - *Only the cheapest 100.* Narrow each search (price range, filters) until `total` ≤ 100. Then
    an id missing from the results is really gone (or repriced out of range; one fetch tells which).
- **Timing is approximate:**
  - Sold time falls between the last check that saw the listing and the first that didn't, plus up
    to ~5 minutes of trade-site indexing delay.
  - "How long it was up" = sold time minus `indexed`. `indexed` probably resets when the price
    changes (unchecked), so also store when the tracker first saw the listing.
- **Budget:** plan on half the sustained limits (~50 searches and ~80 fetches an hour). That's about
  12 watched searches every 15 minutes, or 25 every 30.
  - The search itself shows which ids are still up. Fetch only new ids (for their details) and ids
    that dropped out of the results.
  - Use one shared, queuing rate limiter per endpoint: before each request, wait until every window
    has room. Update the windows from the `X-Rate-Limit-Ip`/`-State` headers after every response,
    and on a 429 honour `Retry-After`.
- **Where it runs:**
  - *GitHub Actions cron* has a 5-minute minimum and starts runs late (the daily job here has run
    hours late). That's poor for sale timing, and every run has to commit its state somewhere.
  - *Vercel cron* depends on the plan; Hobby allows once a day.
  - *An always-on worker* (a small VM or container, or a home machine) is the reliable choice.
  - Storage for listings and sales needs a small database (e.g. Postgres or KV) rather than CSVs on
    the `data` branch, since it changes every few minutes.
  - Unchecked: whether pathofexile.com blocks datacenter IPs (GitHub runners, Vercel). Test with one
    search from the chosen host first.

**Suggested first step:**
1. Build a local script with one watched search (a single unique, price-floored) that polls every
   10 minutes for a day and logs gone/reappeared ids.
2. Use the log to measure false "sales" (reappearances) before building storage and a page.

---

## Done

- **Trade site links.** Uniques (and Vaal Aspects) link to an official trade site search - on every
  table that lists them, the item page, and card flips' unique rewards. (A live bulk-exchange search
  behind the Exchange Price button was tried and removed: the trade site's bulk exchange is nearly
  empty since the in-game Currency Exchange.)
- **Liquidity from poe.ninja's exchange volume.** Divination Card Flips rate a leg with no GGG market
  this hour by poe.ninja's exchange volume (same chaos scale) instead of calling it Low.
- **Dust Value assumes 20% quality.**
- **Dust Value page** (`/dust-value`). Uniques ranked by Thaumaturgic Dust per chaos for Kingsmarch
  disenchanting: poedb's dust values (generated into `lib/disenchant-values.ts`) against poe.ninja's
  cheapest trusted line per unique, with an item-level input and the usual price, confidence and
  Chaos/Divine controls.
- **Divination Card Flips: instant buy could read cheaper than a buy order.** Cost used poe.ninja's
  card price and instant the exchange hour's top - different sources and times, so 13 of 33 cards
  (Divine Beauty, The Doctor, ...) had instant below Cost. Both now come from the exchange hour
  (bottom / top), with poe.ninja only for cards with no exchange market.
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
