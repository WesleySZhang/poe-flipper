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
| 6 | [Sold item tracker](#6-sold-item-tracker) | Live; follow-ups open |
| 7 | [Trade site links don't always match the item](#7-trade-site-links-dont-always-match-the-item) | Open |
| 8 | [Should DuckDB stay in the deployed app?](#8-should-duckdb-stay-in-the-deployed-app) | Discovery |
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
  dust shown. Also unconfirmed: quality would count +2% per point (the in-game text; poedb's
  formula says +1%) if assumed above 0% - the page assumes every item is unqualified.
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

**Built** (`scripts/track-sold-listings.ts`, the "Track sold listings" workflow, `/sold-listings`;
see the README). Searches come from trade site links in `sold-tracker/searches.md`, starting with
Watcher's Eye. Runs ~5.5 hours every 6 hours, checking every listing each run. No price floor of
its own; volume is capped at 3,000 listings per search, 6,000 in total and 20 searches, checked on
every PR and enforced while running. Live since 2026-09-28: GitHub's runners reach the trade site
(no 403 so far). Still open:

- **Sold times for the first sales are late.** The 14 listings that sold before the `gone` fix
  get their sold time from the first run after it (up to ~1.5 days late), and their "Time up" is
  long by the same amount. Listings already settled as unsold after 7 days aren't re-checked, so
  one that actually sold before then stays unsold.
- **Copy item in Craft of Exile** is untested (Path of Building's parser reads it correctly).
- **Spread checks out instead of hitting the limit.** Today, past 6,000 tracked listings new ones
  are skipped, and a search over 3,000 is paused. Those caps exist because every listing is checked
  once per run, and one run's fetch budget covers about 6,750 listings (1,000 fetches per 6 hours
  at 70%, 10 listings each). Instead, when the tracked count goes over what one run can check,
  stretch the recheck interval to fit, e.g. each listing every 2nd run at 12,000 listings. Also
  stretch discovery for busy searches, and keep a ceiling beyond which the data is too stale to use
  (e.g. checks 24 hours apart). The cost is freshness: a sale is timed at the first check that
  finds it gone, so sold times get up to one interval late, and the page moves more slowly.
  Ideas to make it smarter:
  - Over the limit, prioritize by listing age: check recently listed items more often, since they're
    more likely to sell soon, and items up a long time less often (they tend to stay up). Don't try
    to judge whether an item is overpriced - too hard to tell reliably.
  - Show the current interval on the page ("checked every ~12 h").
  - Have the PR check and `admitNewListings` use the new ceiling in place of the fixed caps.
- **Add or remove a search from GitHub Actions.** A manual workflow with inputs (a trade site link,
  an optional label, add or remove) that edits `sold-tracker/searches.md` on a new branch and opens
  a PR, so the existing "Check sold tracker searches" check still runs before merge. Validate the
  link decodes (`parseTradeSearchUrl`) and the label is unique before opening the PR. The PR must
  trigger the check: a PR opened with the default `GITHUB_TOKEN` doesn't start other workflows, so
  use a PAT or GitHub App token.
  No redeploy is needed (checked 2026-09-29): the app doesn't read `searches.md`. The tracker reads
  it once at the start of each run, and the page's search chips come from its published file on
  `sold-tracker-data`, so a merged change shows up at the next run's first publish (up to ~6.5 h
  later). A run already going keeps the old list. To make it quicker, start a tracker run on merge
  when none is running (the workflow's concurrency group would otherwise queue it).
- **Removing a search: what happens to its listings.** How it works today (checked 2026-09-29):
  - The search's status is rebuilt from `searches.md` at each run start, so a removed search's chip
    disappears.
  - Its listings stay in the state and keep being checked until they sell or reach 7 days. They
    still count toward the 6,000 cap, and they only show under All, with a label no chip matches.
  - A renamed label is the same problem: its listings keep the old label.

  **Plan:**
  1. **Listings still up:** when a run starts and finds a label gone, stop checking listings that
     only that search found, and drop them from the state and page file. They aren't results yet,
     and dropping them frees the fetch budget and the cap. Listings another active search also
     matches keep going under that search. Re-adding the search later sweeps its listings back in.
  2. **Sold and unsold listings:** keep them. They stay in the archive, and on the page for the
     usual 30/7 days. Keep the removed search's status with a `removed` date, so its chip still
     shows (greyed, "Removed") while it has listings on the page. Drop the status once it has none.
  3. **Renames:** if a new label has the same link as a removed one, move the listings to the new
     label instead of treating it as a remove plus an add.

  **Culling stored sales when storage gets out of hand:**
  - **Size today:** the archive is ~50-125 KB a day for one search (~540 listings). The state and
    page file are ~1.1 MB each. Near 6,000 listings that's roughly 1-1.5 MB a day, several hundred
    MB a year. GitHub rejects files over 100 MB (day files stay far under) and wants repos under
    ~1-5 GB.
  - **Watch it:** log the archive's total size each run and warn past a set budget (e.g. 500 MB).
    Show the size on the page footer or in the run summary.
  - **Shrink first, delete second:**
    - gzip day files older than ~30 days (JSONL compresses ~10x);
    - write a relisted listing once (the archive can hold it twice);
    - drop per-mod roll ranges from old records if needed.
  - **A cull script / workflow** (`npm run sold:cull`, or a manual workflow with inputs) to delete
    archive records by search label (e.g. everything from a removed search), by age (older than N
    days) or by league (past leagues). It should print what it would delete and only delete with a
    confirm flag.
  - **Culling can't be undone.** Do the archive backup below first, and back up before each cull.
- **Sweep limits.** The per-run sweep (which replaced "backfill a new search") pages by price, so
  it stops at a listing priced in a different currency than the link's price filter (e.g. a chaos
  listing on a divine-priced search), and takes only 200 of a price shared by more than 200
  listings. Neither happens on Watcher's Eye today. Splitting by listing age would cover both.
- **Back up the archive.** `ended/` is the only full history and lives only on `sold-tracker-data`,
  which each publish replaces with a single commit. A run that restored an incomplete copy and
  published would lose it for good. E.g. copy it to a release asset or a second branch weekly.
- **Price sort across currencies.** Price sorts divine listings by amount and puts anything else
  after them (all listings are divine today). A chaos-priced listing needs a divine rate to sort
  in the right place.
- **Scheduled runs start late or not at all.** On 2026-09-28 the 12:20 UTC run never started and
  the 18:20 one started 82 minutes late, so the page went ~8 hours without an update. If it keeps
  happening, run the tracker on an always-on machine.
- **Terms of Use.** The trade API isn't in GGG's docs (see below). The tracker keeps to 70% of the
  rate limits, but it's still steady automated use.
- **Pulled and relisted vs sold.** A seller pulling an item looks like a sale (the fetch says
  `gone: true` for both). Can a later relist move it from Sold back to Unsold?

  **Findings (2026-09-30):**
  - **Partly handled already.** A listing's id is its item's id. If a tracked search's discovery
    or sweep turns up a "sold" id again, `recordListing` reopens it: status back to listed (so it
    moves to the Unsold tab), sold time cleared, "Relisted" badge. So far 0 of 16 sales have come
    back.
  - **A quick pull-and-relist between two checks is never seen.** Checks are ~6 h apart, and only
    a listing that's gone at a check counts as sold, so those don't become false sales.
  - **A gone listing still carries its last seller** (`listing.account.name`), stash, price and
    `indexed`. So "same seller relisted it" can be told apart from "a buyer is reselling it".
    `whisper` holds the character name; don't store it.
  - **`indexed` changes without a price change.** Listing 549c22a9 was first seen listed on
    09-28 05:27. When found gone, its `indexed` read 09-29 17:33, at the same 125d. The seller
    moved it or re-listed it. That's a pull-and-relist signal we don't record (only the first
    `indexed` is kept).

  **Gaps:**
  1. A relist is only noticed if a tracked search shows it. One relisted above the search's price
     range, or once its search is removed, stays counted as sold.
  2. After 7 days (`STATE_KEEP_ENDED_DAYS`) the sold record leaves the state. A relist then is a new
     listing, and the old sale stays in the archive as a sale.
  3. **A real sale that the buyer relists would be wrongly reopened.** Item ids probably survive a
     trade (unchecked), and we don't store the seller, so we can't tell the two apart.
  4. The archive keeps the "sold" line after a reopen until the listing ends again (the later line
     wins). A reopened listing still up reads as sold there.
  5. **Bug: the page shows sales for 7 days, not 30.** `buildSoldListingsFile` is built from the
     state, which drops ended listings after 7 days, so `SOLD_PAGE_DAYS = 30` never takes effect.

  **Plan:**
  1. **Store the seller** on each listing as a short hash of the account name, refreshed at each
     fetch. It's enough to compare, and keeps no names.
  2. **Detect relists two ways (owner's choice, 2026-09-30):**
     - **Free, from the searches.** Discovery and the sweep already reopen a "sold" id they see
       again, for as long as the sold record is in the state. Keep that; it's the main path.
     - **Cheap, by id.** Re-fetch a sold listing by id every other run (~12 h apart) for 1 day
       after the sale: about 2 checks per sale. This catches a relist the search doesn't show
       (e.g. relisted above its price range). Share fetches with the regular checks (10 ids per
       fetch), e.g. `SOLD_RECHECK_DAYS = 1` and `RECHECK_SOLD_MINUTES = 660` beside
       `RECHECK_LISTED_MINUTES`.
     - **Cost:** at ~1.2% of tracked listings selling a day, it's ~1 fetch a day today (~520
       tracked). At the 6,000 cap it's ~4 fetches a run, ~40 of the ~7,000 checks a run can do
       (<1%). The 6,000 cap stays.
  3. **On a reappearance:**
     - **Same seller:** it wasn't a sale. Reopen it (as today), and record when it was pulled and
       relisted.
     - **Different seller:** the sale was real. Keep the sold record and start a new record for the
       resale, linked to it and badged "Resold". That's flipping data worth having.
  4. **Record `indexed` changes** at an unchanged price as a "touched" time, a weaker relist signal.
  5. **Archive the reopen** (a line with status listed), so the archive's latest line is always
     right.
  6. **Fix the 30-day window:** keep ended listings in the state for `SOLD_PAGE_DAYS` (sales are
     few), or build the page's ended listings from the archive's last 30 days. This also widens
     the relist window from gap 2.
  7. **Measure** reopened vs resold counts, to settle how often a "sale" is really a pull.
- **A fresh league's volume** is unmeasured. The PR check counts today's market, so searches near
  the limits may get paused at a league start. Check the page in the first days.
- **Make the PR check required** on `master` (Settings > Branches > required status check
  `check-searches`), so an over-limit search can't be merged.

The research this was built on (2026-09-27/28). Some choices changed in the build - it runs in
GitHub Actions, stores to a branch, and counts a listing sold at the first check that finds it
gone; the README describes what it does now:

**Goal:** list items that sold on the trade site: the item and its mods, price, when it sold and how
long it was listed. A job polls the trade site every few minutes, and a listing that disappears is
assumed sold.

**Scope chosen:** Watcher's Eye only, instant buyout, priced at 100d or more, listed in the last
week. All items is out of scope: ~20,500 listings match even in a late, quiet league, and each
could only be re-checked about once a day.

**Verdict: feasible.** Watcher's Eye is small enough to re-check every listing often:

| Listings tracked | Re-checked about every |
| --- | --- |
| ~540 (now, late Allflame) | ~10 minutes |
| ~2,700 (5x, a guess at an active league) | ~30-40 minutes |
| ~5,400 (10x) | ~1-1.5 hours |

A fresh league's volume is a guess. Measure it in the first days of the next league, and raise the
price floor if re-checks fall too far behind. Findings (probed 2026-09-27/28):

- **Watcher's Eye, measured (2026-09-28, ~06:00 UTC):**
  - 540 listings: instant buyout, 100d+, listed in the last week.
    - Listed in the last day: 146. The newest 100 spanned 15 hours, so about 7 new or repriced
      listings an hour.
    - Any status instead of instant buyout: 643.
    - Instant buyout at any price: over 10,000.
  - Prices run from 100d to 999d, and about a quarter sit at exactly 100d.
  - Each listing's mods come with it (e.g. "Gain 30 Life per Enemy Hit while affected by
    Vitality"), so a sold record can show the full roll.
- **How it would run:**
  - Instant buyout is status `securable`. These listings have a gold `fee` and `online: null`
    (the seller needn't be online), so offline sellers and bait are both handled.
  - *Discovery:* a newest-first search (`sort: {"indexed": "desc"}`) every 10 minutes. About one
    search and one fetch per cycle.
  - *Re-checks, mainly by search:* slice the price range so each search returns ≤100 listings. Any
    tracked id missing from its slice gets one fetch, which marks it `gone: true` if the listing is gone (not `null` - see Done)
    or shows its new price if it was repriced out of the slice.
    - Sorting a slice both newest-first and oldest-first covers up to 200 listings. That's needed
      for the 100d tie, which no price range can split.
    - Budget: at ~70% of the limits, ~54 searches an hour (~5,400 listings) plus ~90 fetches
      (~900 listings). That's what the table above divides up.
  - **A price drop is not a sale** (tested 2026-09-28 with the owner's own Watcher's Eye). Lowering
    it from 100d to 50d kept the same id. A fetch by id returned the new price and a new `indexed`
    (the time of the change), not `null`. The trade site showed the change ~6 minutes later; the
    original listing had taken ~9. So:
    - Track by item id and keep each id's price history.
    - Count a sale only when a fetch says it's gone (`gone: true`). Dropping out of a search, e.g. below the
      100d floor, doesn't count.
    - Store a first-seen time, since `indexed` resets on every price change.
    - Freshness doesn't matter, so wait (say 24 hours) before calling a missing id sold, in case
      it's relisted under the same id.
    - The one false positive left: an item taken off the market for good looks like a sale.
  - Listings still up after 7 days drop out as "unsold after a week".
  - Overpriced listings that never sell still take re-check budget.
- **Storage** is small: a few thousand listings and their sales, each with mods, price, first seen,
  `indexed` and gone time.

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
  - The listing id equals the item's own id, and a repriced item keeps it (tested; see above).
  - ~~A fetch of a listing that's gone returns `null`~~ - wrong: it returns the last listing with
    `gone: true` (found 2026-09-29; see Done). Fetch doesn't need the search id, so it's still a
    cheap "still up?" check, 10 per request.
- **Traps:**
  - *Gone isn't sold.* A listing also disappears when the seller moves the item to a private tab,
    removes its price or uses it. Treat an id as sold only once it's been missing for 2+ checks
    and hasn't reappeared.
  - *Offline sellers and bait* (weeks-old 1c listings): gone with instant buyout only. Without it,
    search with status `any`, since with `online` a seller logging off looks like a sale.
  - *Only the cheapest 100.* Narrow each search (price range, filters) until `total` ≤ 100. Then
    an id missing from the results is really gone (or repriced out of range; one fetch tells which).
- **Timing is approximate:**
  - Sold time falls between the last check that saw the listing and the first that didn't, plus up
    to ~10 minutes of trade-site indexing delay.
  - "How long it was up" = sold time minus the tracker's first-seen time. `indexed` resets on every
    price change, so it only gives the time since the last change.
- **Rate limiter:** use one shared, queuing rate limiter per endpoint: before each request, wait
  until every window has room. Update the windows from the `X-Rate-Limit-Ip`/`-State` headers after
  every response, and on a 429 honour `Retry-After`.
- **Where it runs:**
  - *GitHub Actions cron* has a 5-minute minimum and starts runs late (the daily job here has run
    hours late). That's poor for sale timing, and every run has to commit its state somewhere.
  - *Vercel cron* depends on the plan; Hobby allows once a day.
  - *An always-on worker* (a small VM or container, or a home machine) is the reliable choice.
  - Storage for listings and sales needs a small database (e.g. Postgres or KV) rather than CSVs on
    the `precompute-data` branch, since it changes every few minutes.
  - GitHub's runners are not blocked (checked 2026-09-28); Vercel's are untested.

## 7. Trade site links don't always match the item

The cart-icon links (`tradeSearchUrl` in `lib/trade-site.ts`) search by name, plus a few filters
(Foulborn, 5/6 links, item level on Dust Value), so the results can include items that aren't what
the row prices. Example: the filter doesn't exclude corrupted items when the item isn't corrupted,
so corrupted copies (often cheaper or pricier) show up mixed in.

**To do:** go through what poe.ninja's line for an item actually describes (variant, links,
corruption, base type, gem level/quality, influence, ...) and check each against the link's filters.
Find every gap like corruption, and add the matching trade filter (e.g.
`misc_filters.corrupted: false` for an uncorrupted line). Check a sample of links from each page
against the trade site's results.

## 8. Should DuckDB stay in the deployed app?

Not decided - find out whether it's actually costing anything first. Production still ships `db/history.duckdb` (~72 MB, Git LFS) and DuckDB's native library in the
Vercel function. The main Flip Predictions table doesn't need it (it reads `precompute-data`), but
these routes query it live:

| Route | Used by | Needs |
| --- | --- | --- |
| `/api/price-history` | Every price chart (row expand, item detail page) | One item's past-league daily prices |
| `/api/flip-suggestions` (live path) | Durations outside the precomputed 1–30; League tester's day override | Growth ratios for any day pair |
| `/api/predict-item`, `/api/item-names` | League tester | Same, one item |
| `/api/mirage-simulation` | Mirage simulator | A past league replayed day by day |

**Possible reasons to drop it:** a lighter function (no 72 MB file or native library, so no
`serverExternalPackages`/`outputFileTracingIncludes` workarounds in `next.config.ts`), no LFS
pointer risk on Vercel, and no LFS storage/bandwidth use (every DB rebuild is kept; every build
downloads it).

**Costs:** the testing tools work for any day/duration the user picks, which can't all be
precomputed. Past-league history only changes at a league ingest, so publishing it to a data branch
gains little over files built at ingest and shipped with the app, and adds a runtime fetch from
`raw.githubusercontent.com`.

**Discovery** (answer these, then decide):
1. **Is it a problem today?** Vercel function size and cold-start time for the DuckDB routes vs
   the others; `/api/price-history` response time (first call and warm); build time spent pulling
   LFS. None measured yet.
2. **What does LFS cost?** GitHub LFS storage and bandwidth used this month (repo/account billing
   page) against the plan's allowance, and how many builds a month pull the file.
3. **Are the testing tools used in production?** Vercel logs/analytics for `/api/predict-item`,
   `/api/item-names`, `/api/mirage-simulation`, and `/api/flip-suggestions` calls that miss the
   precomputed file. If nobody uses them there, they can be local-only.
4. **How big would static chart files be?** Export every item's past-league series once and
   measure total size, file count and the largest single item, sharded by item. Compare with the
   72 MB DB.
5. **Middle options:** DuckDB reading a Parquet export over HTTP (from a data branch or blob
   storage) instead of a bundled file; keeping DuckDB but dropping LFS (a release asset or blob
   storage fetched at build/start). Check whether either removes the costs found in 1-2 without
   losing the testing tools.
6. Write the findings and a recommendation here.

**If the answer is to take it out:**
1. At ingest (`scripts/ingest-history.ts`), export each item's past-league chart series to small
   static JSON files. Point `/api/price-history` at them. This covers every everyday page.
2. Make the testing tools local-only, or keep DuckDB for those routes only (per discovery step 3).
3. Remove the `next.config.ts` workarounds and LFS if nothing in production needs DuckDB; update
   README (deploy notes, LFS) and the `new-league` and `precompute-check` skills.

---

## Done

- **Sales were never detected** (fixed 2026-09-29). The tracker counted a sale only when a fetch
  came back `null`, but the trade site returns a sold or pulled listing with `gone: true` instead.
  So every sale read as "still listed", and Sold stayed empty. `fetchListings` now treats `gone`
  as not listed. 14 of 521 tracked listings were gone at the time.
- **Sold tracker follows every listing a search matches** (2026-09-29). Each run starts with a sweep
  that pages the search by price (`sweepIds` in `scripts/track-sold-listings.ts`). Before it, the
  first run only reached the newest and oldest 100 of the backlog: 260 tracked of 544 matching,
  290 never seen. A test run took in 292 and ended at 554 tracked.
- **Copy a sold listing's item as game text** (2026-09-28). "Copy item" on each Sold Listings row
  rebuilds the game's Ctrl+C text from the stored item (`lib/item-text.ts`): identical to GGG's own
  text for 14 real items (minus flavour text), plus the in-game "(implicit)"/"(crafted)" markers, and
  parsed correctly by Path of Building's own parser. Along the way: fractured/crafted mods (which the
  fetch lists among the explicits) and mirrored items ('duplicated') are now recognised. Not tried
  in Craft of Exile.
- **Sold Listings page, reworked** (2026-09-28). Listings still up count as Unsold ("Still listed",
  "Last seen"); a listing counts as sold the first time it's found gone (no "Gone" state); each
  item drawn like the game's tooltip with mod tiers (T1 = best) at the left and roll ranges on
  hover; price timeline with earlier prices struck through; searches as filters; "Tracking N /
  6,000"; sorted by price, lowest first. Page headers on every page lost their duplicate title.
- **Sold tracker files kept small.** The item text and flavour text aren't stored (half of each
  listing; the detail dialog and its "Copy item text" button were removed), and the archive is one
  file per day, so none nears GitHub's 100 MB limit. A listing is ~1.7 KB, so the page file is ~10 MB
  at the 6,000 cap.
- **Trade site links.** Uniques (and Vaal Aspects) link to an official trade site search - on every
  table that lists them, the item page, and card flips' unique rewards. (A live bulk-exchange search
  behind the Exchange Price button was tried and removed: the trade site's bulk exchange is nearly
  empty since the in-game Currency Exchange.)
- **Liquidity from poe.ninja's exchange volume.** Divination Card Flips rate a leg with no GGG market
  this hour by poe.ninja's exchange volume (same chaos scale) instead of calling it Low.
- **Dust Value assumes 0% quality** (unqualified, as most disenchant fodder actually is).
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
