---
name: poe-data-sources
description: Use when deciding where PoE data comes from or why a number is missing/wrong - poe.ninja endpoints, GGG's exchange API, RePoE, poewiki, the history CSVs - and each source's quirks.
---

# PoE data sources

As of: Allflame league (2026-09). Tags: `[verified]` confirmed in repo/source, `[owner]` from the
owner's play knowledge, `[unsure]` unchecked - never present these as settled.

## Facts

| Source | Gives | Quirks |
| --- | --- | --- |
| poe.ninja overview endpoints | Live prices, 7-day sparkline, seller count, by category type | Community service; be polite (cache, few requests). Categories migrate between endpoints. `[verified]` |
| poe.ninja history export | Daily price CSVs per league, published after a league ends | Used to train the model; noisy days need filtering. `GET /poe1/api/data/dumps` lists them (name, min/max date); `/poe1/api/data/dumps/dump?name=<League>` is a ~50 MB zip that also holds hardcore and standard files. Mirage's was up the day after it ended. `[verified]` (`scripts/download-league-history.ts`) |
| GGG Currency Exchange API | Per-hour buy/sell range and volume, by GGG internal ids | Ids are game-file paths, not names; needs a name map. ~2h stale. `[verified]` |
| GGG leagues API (`api.pathofexile.com/leagues?type=main&realm=pc`) | Every league's `startAt` / `endAt` | Public, no login needed (checked 2026-09-26). `endAt` is null while a league has no set end. `[verified]` (`scripts/sync-current-league.ts`) |
| RePoE (repoe-fork) | Game-file dump: item names, ids, divination card stack sizes and reward text | Unofficial community mirror; the source for the name map and card data. `[verified]` |
| poewiki.net | Item/mechanic pages | Not Fandom; the app links to it per item. `[verified]` |
| poedb.tw | Game-data tables, e.g. per-unique Thaumaturgic Dust values (Kingsmarch page, Disenchant tab) | A site, not an API: scrape the HTML tables. See `poe-disenchanting`. `[verified]` |

- poe.ninja's sparkline points are the % change vs a fixed base 6-7 days earlier, oldest first, `null`
  on a day with no price; the last point is today. `[verified]` (`lib/poe-ninja.ts`)
- Rebuilding a past day from the sparkline (anchored on today's price) matches stored daily prices
  exactly for stash items (median error 0.0%). For exchange-priced types (currency, scarabs, cards,
  essences, ...) it's within a median ~8-17% of a single live reading, and the gap is mostly the
  reading's noise: a thin exchange market's live price can jump day to day (Timeless Templar
  Splinter read 22c, 3c, 0.3c, 0.02c, 20c on consecutive days) while the sparkline is steadier.
  `[verified]` (tested 2026-09-27; `lib/spark-backfill.ts`)
- GGG's Currency Exchange `lowest_stock` / `highest_stock` are each side's lowest and highest
  listed stock during the hour, not stock at the low or high price: the API has no order-book depth
  and no split of stock by price. A pair can trade with 0 of the item listed at both extremes (orders
  filled as soon as they were placed). `[verified]` (2026-09-27; `stockRange` in `lib/faustus.ts`)
  The in-game exchange's order book (stock at each price) is only visible in game.
- The trade site's bulk exchange (`POST https://www.pathofexile.com/api/trade/exchange/<League>`,
  body `{"query":{"status":{"option":"online"|"any"},"have":["chaos","divine"],"want":["the-doctor"]},"sort":{"have":"asc"},"engine":"new"}`)
  gives price + stock per listing inline (no second fetch) and needs no login, but it's a thin market
  since the in-game exchange: on 2026-09-28, online listings were 4 for Divine Orb, 5 Stacked Deck,
  1 The Doctor; "any" adds weeks-old offline bait (1c Doctors). A query can take `minimum` (only
  sellers with at least that much stock). The app's Exchange Price button uses it
  (`lib/trade-exchange.ts`). `[verified]`
- Trade item ids (`the-doctor`, `divine`) are the same as poe.ninja's exchange-overview line ids -
  726 of 728 matched `/api/trade/data/static` on 2026-09-28 (the 2 misses were too new for the trade
  site). So `CurrencyPrice.tradeId` comes free with the exchange overview. `[verified]`
- Trade item search (`POST /api/trade/search/<League>`): a unique searches by `name` alone (no base
  type needed). A Foulborn (mutated) unique is NOT a trade name ("Unknown item name") - search the
  base name with `filters.misc_filters.filters.mutated`. Other filters that work: `status`
  `available` (online or instant buyout), `trade_filters.collapse` (one listing per account),
  `misc_filters.ilvl.min`, `socket_filters.links.min`. A link with the query in it,
  `/trade/search/<League>?q=<json>`, runs the search in the user's browser (`lib/trade-site.ts`).
  `[verified]` (2026-09-28)
- **Trade API rate limits are per IP and punish overruns** with a timeout (the third number). Every
  response reports them: `X-Rate-Limit-Rules: Ip`, `X-Rate-Limit-Ip: max:window:timeout,...`,
  `X-Rate-Limit-Ip-State: used:window:activeTimeout,...`. Search: `5:10:60,15:60:300,30:300:1800,
  600:21600:3600`; bulk exchange: `5:15:60,10:90:300,30:300:1800` (2026-09-28). Read them from the
  headers, don't hard-code them; they differ per endpoint and can change. `Retry-After` on a 429.
  `[verified]` (`lib/trade-rate-limit.ts`)
- poe.ninja's exchange overview lines carry `volumePrimaryValue`: chaos traded, on about the same
  scale as GGG's hourly exchange volume (median ratio ~0.85, p10-p90 ~0.3-3, across Currency,
  Scarab, Essence, DivinationCard on 2026-09-28), so hourly chaos-volume tiers apply to it. It covers
  items GGG's hourly data has no market for (153 of 213 cards that hour). `[verified]`
- poe.ninja also serves every category in one response:
  `/poe1/api/economy/current/dense/overviews?league=<League>&language=en` (~366 KB, ~0.3 s). Lines
  are only `{name, variant, chaos, graph}` - no seller count, links, detailsId or base type, and
  variants embed the base type and links ("…, Sage's Robe, 6L"). Stash-type prices (uniques, gems)
  match the per-type endpoints; currency and card prices don't match the exchange overview (71 of
  213 cards, 77 of 100 currencies differed on 2026-09-28). Not used by the app yet (TODO). `[verified]`
- poe.ninja has **no API listing its categories**. Its site sidebar is built from a config object
  compiled into one of its JavaScript chunks (`{availableViews:[...], title, type, url}` per
  category); chunk names change every deploy, so find it by walking the imports from the page's
  entry scripts (~50 files, ~2 s). `/poe1/api/data/index-state` lists leagues only. `[verified]`
  (`fetchNinjaCategories` in `scripts/generated-data.ts`)
- poe.ninja item pages: `https://poe.ninja/poe1/economy/<league-lowercase>/<category-slug>/<detailsId>`
  (e.g. `.../allflame/divination-cards/the-nurse`). Category slugs are read off poe.ninja's nav; a stash
  item's `detailsId` comes on its API line (it folds in variant + base type), a currency-style one is the
  slugified name with apostrophes dropped. `?search=` on a category page did not filter. `[verified]`
  (`lib/ninja-link.ts`)
- The current league has no ingested daily history until it ends; the app collects its own daily
  snapshots into CSVs on the `data` branch to fill that gap. They're a weaker substitute for
  poe.ninja's export: only items the live API lists, `Confidence` always "High", and only since
  collection began (Allflame: from 2026-09-22, league day ~60). Train on the export instead. `[verified]`
- poe.ninja's `/poe1/api/economy/leagues` lists the live league first (e.g. Allflame, Hardcore
  Allflame, Standard, Hardcore); the swap check reads `[0]`. Whether it switches the moment a league
  launches is unchecked. `[unsure]`

## In this app

- Live prices: `lib/poe-ninja.ts`; daily snapshot: `lib/price-snapshot.ts` (`prices.json`).
- Exchange: `lib/faustus.ts` (`FAUSTUS_NAME_TO_ID`, generated by `scripts/generate-faustus-mapping.ts`).
- Card data: `lib/divination-cards.ts` (generated by `scripts/generate-divination-cards.ts`).
- Official trade site: search links `lib/trade-site.ts`; the Exchange Price bulk-exchange search
  `lib/trade-exchange.ts`, rate limited by `lib/trade-rate-limit.ts`.
- Past-league history: `db/history.duckdb`, built by `scripts/ingest-history.ts`.
- Current-league history: CSVs on the `data` branch, read by `lib/current-league-history.ts`.

## Sources

- https://poe.ninja  |  https://github.com/repoe-fork/repoe  |  https://www.poewiki.net
- GGG developer docs (Currency Exchange endpoint)
- `docs/faustus-mapping.md` for the full id map

## Owner notes

<!-- Add trusted tools, sites, or sources you use and what they are good/bad at. -->

## Gaps

- No documented rate-limit numbers for poe.ninja or GGG's endpoints.
- The official trade API and its OAuth requirement are not covered.
