---
name: poe-data-sources
description: Use when deciding where PoE data comes from or why a number is missing/wrong - poe.ninja endpoints, GGG's Currency Exchange API, the trade site's search/fetch API (listing fields, gone flag, rate limits, paging), RePoE, poewiki, the history CSVs - and each source's quirks.
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
  sellers with at least that much stock). The app tried it behind the Exchange Price button and
  dropped it as effectively dead (owner's call, 2026-09-28). `[verified]`
- Trade item ids (`the-doctor`, `divine`) are the same as poe.ninja's exchange-overview line ids -
  726 of 728 matched `/api/trade/data/static` on 2026-09-28 (the 2 misses were too new for the trade
  site), so a name-to-trade-id map comes free with the exchange overview. `[verified]`
- Trade item search (`POST /api/trade/search/<League>`): a unique searches by `name` alone (no base
  type needed). A Foulborn (mutated) unique is NOT a trade name ("Unknown item name") - search the
  base name with `filters.misc_filters.filters.mutated`. Other filters that work: `status`
  `available` (online or instant buyout), `trade_filters.collapse` (one listing per account),
  `misc_filters.ilvl.min`, `socket_filters.links.min`. A link with the query in it,
  `/trade/search/<League>?q=<json>`, runs the search in the user's browser (`lib/trade-site.ts`).
  `[verified]` (2026-09-28)
- A search returns at most 100 result ids (cheapest first) plus `total`. `GET /api/trade/fetch/<up to
  10 ids>` returns the listings; `?query=<search id>` is optional. Each has `item` (full mods, ilvl,
  ...) and `listing` (`indexed` = listed/last changed, `price` {type `~b/o`/`~price`, amount,
  currency}, `account` {name, online}, `stash` {name, x, y}, `method: "psapi"`). The result id equals
  `item.id`. **A listing that sold or was pulled is NOT `null`**: the fetch still returns its last
  listing (old price, stash, account) with top-level **`gone: true`** and `item.verified: false`.
  Only an id that never existed comes back `null`. So the "still listed?" check is `!r || r.gone`.
  Checked on 521 tracked Watcher's Eyes: 14 had `gone: true`, all 14 missing from the search and
  from their seller's own listings; none of the rest had it. `?query=<search id>` on the fetch
  changes nothing. `[verified]` (2026-09-29; an earlier note here said `null`, which was wrong)
  A gone listing keeps its last `listing.account.name`, `stash`, `price` and `indexed` - so who
  listed it is still readable after it sells (16 of 16 checked, 2026-09-30). `[verified]`
- Whether an item keeps its id when it changes hands (bought, then relisted by the buyer) is
  unchecked (the id does survive repricing). `[unsure]` The sold tracker assumes it might, and
  compares the seller (as a hash) when a sold id comes back; a first "Resold" in its run log would
  confirm it.
- `indexed` changing at an unchanged price is common: 2 of 10 live Watcher's Eyes checked on
  2026-10-02 had moved since first seen. `[verified]`
- `indexed` also changes without a price change: a Watcher's Eye first seen at 125d (indexed
  09-28 05:27) read indexed 09-29 17:33 at the same 125d when found gone. It's likely the seller
  moving or re-listing it. `[verified]` (the reset; the cause is `[unsure]`)
- **Getting every listing past the 100 cap:** sort `{"price": "asc"}`, take the page, fetch its last
  id for its price, and search again with `trade_filters.price.min` = that price (inclusive; ids
  repeat, dedupe). When a whole page shares one price (e.g. 105 Watcher's Eyes at exactly 100d),
  search `min = max = price` sorted `{"indexed": "desc"}` and `"asc"` (covers 200), then continue
  from price + 0.01. Paging needs listing prices in the filter's unit: `price.option` "divine" =
  divine-priced, no option = chaos equivalent. 544 listings took 8 searches (2026-09-29).
  Bisecting the price range instead (split until each slice is under 100) works but costs many
  more searches. Newest-first alone (`indexed` desc) only ever sees the latest 100.
  `[verified]` (2026-09-29)
- Other search filters: `status.option` "securable" = instant buyout only; `trade_filters.indexed`
  ("1day", "3days", "1week", "2weeks", ...) = listed or last repriced within that window - a
  2-week window roughly doubles a week's count. `total` is exact up to 10,000. `[verified]`
- A fetched listing's `item` carries far more than names and mod text (2026-09-28):
  - each mod as `{description, hash, mods: [{magnitudes: [{min, max}]}]}` - `min`/`max` is the
    **roll range** of each number in the mod (a Watcher's Eye "60% increased Lightning Damage while
    affected by Wrath" has 40-60; a fixed mod has min = max). Magic/rare explicit mods also have
    `name` ("of the Furnace"), `tier` ("P7" = prefix tier 7, "S2" = suffix tier 2; 1 is best) and
    `level`. Unique mods and implicits have no tier. A crafted mod's tier is "R1" (a bench rank).
    `[verified]` (2026-09-28)
  - **Fractured and crafted mods sit inside `explicitMods`**, marked `domain: "fractured"` /
    `"crafted"` (and `flags`), not in `fracturedMods` / `craftedMods`. `[verified]` (2026-09-28)
  - `properties` / `requirements` as `{name, values: [[text, displayType]]}` ("Limited to", [["1",0]]).
    displayType 0 = plain, 1 = augmented (changed by a mod), 4/5/6 = fire/cold/lightning damage
    (7 = chaos, assumed); the item text writes "(augmented)" after 1 and 4-7. `[verified]`
  - `sockets` (`{group, sColour}`; same group = linked), `influences`, `corrupted`, `fractured`,
    `synthesised`, `isRelic`, `foilVariation` (a number - the foil's name is only in the item text),
    `flavourText`, `descrText`. **A mirrored item is `duplicated: true`** - there is no `mirrored`
    field. `[verified]` (2026-09-28)
  - `extended.text`: the in-game item text (what Ctrl+C copies), base64 - pastes into Path of
    Building. See the `poe-item-display` skill for rendering it. `[verified]`
- Repricing keeps the listing id. A Watcher's Eye lowered from 100d to 50d kept its id. A fetch
  returned the new price, with `indexed` reset to the time of the change and the gold `fee`
  unchanged. The change reached the trade site ~6 minutes later (the original listing took ~9).
  `[verified]` (2026-09-28)
- Status `securable` = instant buyout only; its listings carry a gold `fee` and `account.online:
  null`. A search's `total` caps at 10,000. `sort: {"indexed": "desc"}` lists newest first. Filter
  by listing age with `trade_filters.indexed` (`1day`, `1week`, ...) and by price with
  `trade_filters.price` (`min`/`max`, `option: "divine"`). `[verified]` (2026-09-28)
- A trade site search link's id (`/trade/search/<League>/H4sI...`) IS the query: gzipped JSON,
  base64url (`H4sI` = gzip's header), with no sort. Decode it locally; the API has no lookup by id
  (`GET /api/trade/search/<League>/<id>` is a 404). `[verified]` (2026-09-28; `lib/trade-query.ts`)
- **Trade API rate limits are per IP and punish overruns** with a timeout (the third number). Every
  response reports them: `X-Rate-Limit-Rules: Ip`, `X-Rate-Limit-Ip: max:window:timeout,...`,
  `X-Rate-Limit-Ip-State: used:window:activeTimeout,...`. Search: `5:10:60,15:60:300,30:300:1800,
  600:21600:3600`; fetch: `12:4:10,16:12:300,50:300:300,1000:21600:1800` (2026-09-27); bulk
  exchange: `5:15:60,10:90:300,30:300:1800` (2026-09-28). Read them from the
  headers, don't hard-code them; they differ per endpoint and can change. `Retry-After` on a 429.
  Every user of a server-side caller shares the server's IP - prefer links (the search runs in the
  user's browser). `[verified]`
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
  snapshots into CSVs on the `precompute-data` branch to fill that gap. They're a weaker substitute for
  poe.ninja's export: only items the live API lists, `Confidence` always "High", and only since
  collection began (Allflame: from 2026-09-22, league day ~60). Train on the export instead. `[verified]`
- poe.ninja's `/poe1/api/economy/leagues` lists the live league first (e.g. Allflame, Hardcore
  Allflame, Standard, Hardcore); the swap check reads `[0]`. Whether it switches the moment a league
  launches is unchecked. `[unsure]`

## In this app

- Live prices: `lib/poe-ninja.ts`; daily snapshot: `lib/price-snapshot.ts` (`prices.json`).
- Exchange: `lib/faustus.ts` (`FAUSTUS_NAME_TO_ID`, generated by `scripts/generate-faustus-mapping.ts`).
- Card data: `lib/divination-cards.ts` (generated by `scripts/generate-divination-cards.ts`).
- Official trade site: search links, `lib/trade-site.ts` - the running app makes no trade API calls.
  The sold listing tracker (`scripts/track-sold-listings.ts`, a separate job) does, through the
  queuing rate limiter in `lib/trade-api.ts`; see the `sold-tracker` project skill.
- Past-league history: `db/history.duckdb`, built by `scripts/ingest-history.ts`.
- Current-league history: CSVs on the `precompute-data` branch, read by `lib/current-league-history.ts`.

## Sources

- https://poe.ninja  |  https://github.com/repoe-fork/repoe  |  https://www.poewiki.net
- GGG developer docs (Currency Exchange endpoint)
- `docs/faustus-mapping.md` for the full id map

## Owner notes

<!-- Add trusted tools, sites, or sources you use and what they are good/bad at. -->

## Gaps

- No documented rate-limit numbers for poe.ninja or GGG's endpoints.
- GGG's public stash API (`GET /public-stash-tabs`, scope `service:psapi`, 5-minute delay) is the
  official feed of every stash change, but its docs say "We are currently unable to process new
  applications" (2026-09-27). The trade site API isn't in GGG's docs, which call reverse-engineering
  undocumented endpoints a Terms of Use (7i) breach. See TODO.md's "Sold tracker: Terms of Use" and "Sold tracker: background". `[verified]`
