# PoE Flipper

A Path of Exile trading assistant. It predicts which items and currency are likely to gain value
over the next few days of the current league, finds same-day flips on GGG's Currency Exchange
and in divination card turn-ins, and tracks which trade site listings sell.

Built with Next.js, DuckDB (an embedded database holding past leagues' price history) and a small
learned model. Prices come from [poe.ninja](https://poe.ninja) and GGG's Currency Exchange API.

- [Pages](#pages)
- [How predictions work](#how-predictions-work)
- [The daily data job](#the-daily-data-job)
- [The sold listing tracker](#the-sold-listing-tracker)
- [Setup](#setup)
- [Updating data and the model](#updating-data-and-the-model)
- [Deploying](#deploying)
- [Working on this repo](#working-on-this-repo)
- [Known limitations](#known-limitations)
- [Project structure](#project-structure)

See [`TODO.md`](TODO.md) for open ideas and known gaps.

---

## Pages

| Page | Path | What it's for |
| --- | --- | --- |
| **Flip Predictions** | `/` | Items ranked by predicted growth over a chosen number of days (default 7). |
| **Currency Exchange Flip** | `/currency_exchange_flip` | Live buy/sell spreads on GGG's Currency Exchange, for flipping today. |
| **Divination Card Flips** | `/divination-cards` | Cards whose full stack costs less than the reward it turns into. |
| **Dust Value** | `/dust-value` | Uniques ranked by Thaumaturgic Dust per chaos, for disenchanting in Kingsmarch. |
| **Sold Listings** | `/sold-listings` | Trade site listings the sold listing tracker followed: what sold, at what price, after how long. |
| **Item detail** | `/item/<category>/<Item_Name>` | Everything the app knows about one item. |
| **Mirage league simulator** | `/mirage-simulator` | Replays a finished league to compare predictions with what happened. |
| **League tester** | `/current-league-tester` | Applies an item's historical growth to a price you type in. |

### Flip Predictions

Pick a "Days ahead" value with the slider (1–30, instant) or type any number (beyond 30 triggers a
live calculation). Each row shows the current price, predicted price, change and a confidence tier.

- **Click a row** to expand a price chart across every past league, with markers for today and
  the target day, and the model's day-by-day forecast as a dotted line.
- **Click an item's name** to open its detail page. The small icon next to it opens poewiki; a cart
  icon on uniques opens a trade site search.
- **Filters:** category, price range, search, and confidence tier (Low is hidden by default).
- **Chaos / Divine** toggle switches every price and ratio to that currency.

### Currency Exchange Flip

Buy/sell spreads from GGG's own exchange data, with trade volume, a liquidity tier and the gold
cost per trade. GGG's API is historical (about 2 hours old) and has no gold-cost field, so gold
costs are transcribed from community sources (`lib/faustus-gold.ts`).

An item can trade against Chaos and against Divine on separate markets that don't always agree, so
each row takes the best of four routes: buy with either currency, sell for either. Buy and Sell
are shown in the currency their market trades in (`c` or `d`; hover for the other). Profit is in
divines only when both legs are. There's no Chaos/Divine toggle on this page. Divine legs are valued
at the hour's Divine rate for sorting and profit. A market more than 2× away from the item's other
one is ignored as an odd trade.

### Divination Card Flips

Cost of a full stack (card price × stack size) versus the value of its reward, at today's prices.

- **Cost** is a buy order: the bottom of the card's last closed hour on the Currency Exchange ×
  stack size. A card with no exchange market falls back to poe.ninja's price.
- **Chaos mode:** cards on their Chaos market, the reward at its chaos price.
- **Divine mode:** cards bought with divines, on their own Divine market, not a conversion. A card
  with no Divine market that hour is hidden. The reward is still valued at its chaos price,
  converted to divines.
- **Instant buy** (button, off by default): Cost, Profit % and Profit switch to the stack bought off
  other players' sell orders: the top of the same hour's range × stack size, so it's never below
  Cost (often equal: many cards trade at one price in an hour). Cards with no exchange market, or
  fewer listed than a stack at any point that hour, are hidden. The item page's card section has the
  same button.
- Hovering Min/Max shows the stock listed on that market during the hour (cards for sale, currency in
  buy orders), lowest to highest.

Only cards with a single, fixed, priceable reward are included: a specific unique, a set amount of
currency, another card, or a specific plain item. Excluded:

- random rewards (a random unique of a class, a random gem roll);
- guaranteed-corrupted uniques, since poe.ninja has no separate corrupted price.

Magic/rare rewards are priced as their base type, ignoring affixes. Card data is generated from
RePoE's game files (`scripts/generate-divination-cards.ts`).

"Confidence" here means **liquidity**: the weaker of the two trades (buying the card, selling the
reward). Each leg uses GGG's traded volume that hour, or poe.ninja's exchange volume when GGG had no
market for it (most cards in a given hour). A unique reward has a cart icon for its trade site search.

### Dust Value

Uniques ranked by how much Thaumaturgic Dust they give when disenchanted in Kingsmarch, per chaos
(or divine) they cost. Dust values come from poedb's Kingsmarch page
(`scripts/generate-disenchant-values.ts`); prices are poe.ninja's.

- **One row per unique:** its cheapest poe.ninja line (variant, link count), preferring lines with at
  least 5 sellers so a lone lowball listing doesn't win.
- **Item level** (default 84) scales the dust shown: ×1 at 65 and below up to ×20 at 84+. It's the
  same factor for every unique, so it never changes the order. poe.ninja prices don't say a
  listing's item level; each row's cart icon searches the trade site at that item level or above.
- **0% quality** is assumed for every item (unqualified, as most disenchant fodder actually is).
- **Confidence** is the seller count on poe.ninja (High 20+, Medium 5+).
- **Left out:** Foulborn (mutated) uniques, since it's unchecked whether they give their base's dust;
  corruption and influence bonuses.

### Sold Listings

What happened to the trade site listings the [sold listing tracker](#the-sold-listing-tracker)
followed: instant buyout, from the searches in [`sold-tracker/searches.md`](sold-tracker/searches.md).

- **Tabs:** Sold (last 30 days) and Unsold: every listing still up (badged "Still listed", with
  when the tracker last saw it) plus those that expired a week after listing (last 7 days).
- **Each row:** the item drawn like the game's own tooltip (`components/poe-item-tooltip.tsx`; the
  game's dark look in dark mode, black and white in light mode),
  taking most of the width, with the listing's facts stacked beside it (under it on a phone):
  every price it had, earlier ones struck through, each with how long it stood at that price; when
  it was listed; when it sold or expired; how long it was up; the search that found it. Sort by
  price (the default, lowest first), sold/expired time, listed time or time up. Price sorts divine
  listings by amount; any priced in another currency come after them.
- **Each item shows** every mod, centred, with its tier at the left (T1 = best; magic/rare mods
  only). Hover a mod (tap, on a phone) to see its roll range at the right, e.g. `(40–60)` for
  `46% increased Attack Damage while affected by Precision`. Also properties, item level,
  influences, relic/foil and corruption. Rows don't open anything, so text can be selected. Listings
  recorded before details were kept get them at their next check.
- **Copy item** puts the item on the clipboard as the game's Ctrl+C text (`lib/item-text.ts`), for
  Path of Building, Craft of Exile or the trade site's search.
- **The searches** are listed first, as filters: pick one or more to see only the listings they
  found (All = every search); each shows how many of the current tab's listings it found, and its
  hover shows how many listings it matches on the trade site now. "paused" means a
  search grew past the per-search limit; a warning icon means it failed or got more than 200 new
  listings between runs (so it missed some). Under them, "Tracking N / 6,000" shows how many
  listings are followed against the limit; a red line means it's reached and new listings are
  being skipped.

### Item detail page

Reached from any item name, or from the header search. It shows:

- a **Days ahead** slider and a large price chart with the detailed forecast line;
- **Overview**: current price, predicted price, change, category, seller count;
- **Historical performance**: model prediction, past-leagues average, leagues used, share of
  leagues that rose, forecast precision (hover any label for a short explanation);
- **Recent momentum**: 1/3/6-day change, volatility and acceleration, from the same inputs the
  model uses;
- **Currency Exchange** (if the item trades there): the same flip as the Currency Exchange Flip
  table, each price in its market's currency whatever the page's Chaos/Divine toggle says;
- **Divination Card Flip** (if it's a card);
- links to the item's **poewiki** and **poe.ninja** pages, and for a unique, a **trade site** search.

On desktop the chart and Overview take the left 70%, and the other cards stack on the right.

### Shared across pages

- **Header:** app name, page links (a menu button on narrower screens), theme toggle and a
  **global search** box. Search suggests any item poe.ninja currently prices as you type, and
  opens its detail page. On a phone it's an icon that opens a full-width search.
- **Page layout:** the page title is the header's alone - panels have no title of their own. Each
  panel's controls (search, filters, Chaos/Divine toggle) share one wrapping row at its top.
- **Mobile:** tables become stacked cards, with a "Sort by" control and the confidence/liquidity
  filter above them. Nothing needs horizontal scrolling. The league tester doesn't have this yet.
- **Charts:** the current league has its own solid line up to today, joining the dotted forecast.
  On touch devices a tap shows the tooltip; the bar under the chart is for zooming.
- **Trade site links** (cart icon) for items not on the Currency Exchange - uniques, including Vaal
  Aspects: the official trade site's search for that item (online or instant-buyout sellers,
  cheapest first, one listing per seller; link count when the row is a 5/6-link line). The search
  runs in your browser, not through this app (`lib/trade-site.ts`).

---

## How predictions work

1. **Historical growth.** For each item, the app looks up how its price changed over the same
   stretch of days in past leagues (`lib/growth-ratios.ts`). It needs at least **3 past leagues**
   with a price near both today and the target day. Every league counts equally.
2. **Learned adjustment.** A gradient-boosted model adjusts that average using how today's price
   compares with past leagues on the same day (expensive items tend to fall, cheap ones to rise)
   and poe.ninja's 7-day sparkline (currency momentum tends to continue, items' does not).
   Replaying the finished Mirage league with a model that never saw it, rank correlation went from
   0.185 to 0.334, and the share of top-10% picks that actually gained from 61.7% to 72.8%.
   Details in [`ml/README.md`](ml/README.md).
3. **Confidence tier (High/Medium/Low).** How consistently the item gained in past leagues, not
   how big the predicted gain is (`lib/confidence.ts`). "Forecast precision" is a separate number:
   how wide the model's own uncertainty range is for this item.
4. **Filling gaps.** One past league with a hole in an item's data can drop it below 3 leagues for
   a stretch of days. The daily job fills those gaps so every item gets all 30 days
   (`lib/horizon-fill.ts`): interpolated between real days, or held flat past the last one.
   Filled days are marked on the detail page and their confidence is cut to 75% (held: 50%), so
   almost all land in Low. Against the model's own output, a hidden 10-day stretch was reproduced
   with a median error of about 2%.

The model is chosen with `PREDICTOR`: `xgb` (default), `formula` (a simpler per-day linear model)
or `baseline` (the plain historical average). A missing model file falls back automatically.

The current league and its start date are set in `lib/league-recency.ts`. A daily GitHub Action
checks poe.ninja for a new league and opens a pull request with the change, taking the start date
from GGG's leagues API (`.github/workflows/check-current-league-swap.yml`). `npm run check-league` checks by hand;
`npm run league:sync` applies the change locally.

---

## The daily data job

`.github/workflows/precompute-predictions.yml` runs once a day (cron 00:10 UTC), on demand, and on
any push to `master` that changes the prediction code. It publishes to the **`precompute-data` branch**, which
never triggers a Vercel deploy. Each run replaces the branch with fresh files:

| File | Made by | Used for |
| --- | --- | --- |
| `prices.json` (~1.7 MB) | `scripts/precompute-price-snapshot.ts` | poe.ninja's whole price map (price, type, sparkline, seller count, poe.ninja id) plus which categories had listings. The detail page, search and Mirage simulator read this instead of calling poe.ninja. |
| `predictions.json` (~20 MB, ~5 MB gzipped) | `scripts/precompute-predictions.ts` | Every item's prediction for every "Days ahead" from 1 to 30. |
| `history/<League>/*.csv` | `scripts/precompute-price-history.ts` | The current league's daily prices, one CSV pair per month. Earlier months and ended leagues' folders are kept (the job copies them forward). A missed day within the last 6 is rebuilt from poe.ninja's sparkline (see below). |

How the app uses them:

- **Instant slider.** The browser downloads `predictions.json` once and rebuilds each day's rows
  itself (`lib/predicted-suggestion.ts`), so dragging the slider makes no network requests.
- **Late runs are expected.** GitHub starts the scheduled run hours late (usually 04:00–05:00 UTC).
  Until it lands, the app uses yesterday's file shifted to today: yesterday's 5-day forecast is
  today's 4-day forecast (`alignPrecomputedToDay`). A day-old file covers 1–29 days; files more
  than 2 days old are rejected.
- **When a file can't be used** (missing, wrong league, too old): predictions fall back to a live
  calculation, prices to live poe.ninja, and the chart shows only a straight today-to-target line.
- **Fewer poe.ninja calls.** The job's three scripts share one set of poe.ninja responses through a
  disk cache (`POE_NINJA_DISK_CACHE`), about 48 requests per run. Divination Card Flips still fetch
  live prices but skip categories that had no listings.
- **Missed days are rebuilt.** If a run is skipped or fails, the next one rebuilds any of the last
  6 days with no rows from each price's 7-day poe.ninja sparkline, tagged `Confidence=Medium`
  (`lib/spark-backfill.ts`). Stash items come back exact; exchange-priced types within a median
  ~8-17% of what the job would have read. Older holes can't be rebuilt and show as a warning in
  the Actions run.
- **Caching.** The app re-checks the predictions and history files every 2 minutes and the price
  snapshot every 30 minutes, so a new day is picked up quickly. The predictions endpoint is also
  cached at Vercel's CDN for 2 minutes (`s-maxage=120`), so repeat visits don't run the function.

---

## The sold listing tracker

`scripts/track-sold-listings.ts` follows trade site listings and records which ones sell. The
"Track sold listings" workflow (`.github/workflows/track-sold-listings.yml`) runs it for ~5.5 hours
every 6 hours, then publishes to the **`sold-tracker-data` branch** (not `precompute-data`, which the daily job
rebuilds from scratch):

| File | What it is |
| --- | --- |
| `state/<League>.json` | The tracker's state: listed listings, ones that ended in the last week, search status |
| `sold-listings/<League>.json` | What the Sold Listings page reads (`lib/sold-listings.ts`): sales from the last 30 days, unsold from the last 7, every listing still up |
| `ended/<League>/<YYYY-MM-DD>.jsonl` | Every listing that ended, by the day it ended, one per line - the full history |

- **Published as it goes:** every 30 minutes during a run, and once more at its end (even if
  tracking failed partway), `scripts/publish-sold-tracker.sh` force-pushes a full snapshot of the
  three folders as one fresh commit. Each publish is complete and consistent (taken straight after
  a save, from the tracker's own process), so publishing again is harmless and a failed push just
  leaves the previous snapshot. It never touches the job's checkout. The archive skips listings
  it already holds, so a run that stopped between archiving and saving doesn't write them twice.

- **What it tracks:** the searches in [`sold-tracker/searches.md`](sold-tracker/searches.md). Add
  one by pasting a trade site link as a list item; the link's id is the search itself, gzipped
  (`lib/trade-query.ts`), so reading it costs no request. The tracker adds its own rules to every
  search: instant buyout only (no offline sellers or bait), listed in the last week, current league.
  Everything else, including any price range, is the link's.
- **Finding listings:** a search returns at most 100 listings, so two passes:
  - **A sweep at the start of each run** pages through every listing a search matches, cheapest
    first, 100 at a time (each page starts at the last one's price; a price shared by a whole page,
    like a round 100d, is taken newest and oldest first, up to 200). It takes in everything not yet
    tracked, so "Tracking N" matches the trade site's count from the first run - including the
    backlog already listed when a search is added. ~1 search per 100 listings.
  - **Discovery during the run**, newest-first every 30 minutes (sooner when busy), keeps up with
    new listings; when all 100 are new it also fetches the oldest 100 since the last pass.
- **How long records are kept:** a sale shows on the page for 30 days and an unsold listing for 7;
  the state keeps ended listings 7 days; the archive keeps them forever. There's no backup: each
  publish replaces the branch with one commit, so its history holds no older copies.
- **Deciding a sale:** every listing is checked by its item id once per run. A fetch by id ignores
  the search's filters, and the id survives a price change, so a price drop (even out of the
  search's price range) is recorded as a new price, not a sale (repricing happens in place). A
  listing counts as sold at the first check that finds it gone - pulling an item to relist it later
  is rare - and is reopened, marked Relisted, if it does come back. One still up after a week counts
  as unsold. Times on the page are accurate to about 6 hours.
- **Rate limits:** GGG limits the trade API per IP. `lib/trade-api.ts` queues every request until
  each limit window has room, keeps to 70% of each limit, and follows the limits and usage the
  site reports on every response. The fetch limit (1,000 per 6 hours, 10 listings each) is the
  ceiling: at 70% that's ~7,000 listing checks per 6 hours. Fetches are paced ~25 s apart, so a
  run's ~600 are spread over its hours instead of spent in bursts.
- **Limits on volume** (`lib/sold-tracker.ts`): 3,000 listings per search, 6,000 in total (every
  listing checked each 6 hours, with room for GitHub's late starts), 20 searches. Enforced before merge by the **"Check sold tracker searches"** PR check
  (`scripts/check-sold-searches.ts`, `npm run sold:check` locally): it runs every search on the
  trade site and fails the PR when a limit is over, a link can't be read, two searches share a
  label, or the trade site can't be reached. To make it block merging, add `check-searches` as a
  required status check on `master` (Settings > Branches). And enforced while running, since the
  market grows after a search is approved (a league start): a search past 3,000 is paused (its
  tracked listings are still checked), and at 6,000 tracked listings new ones are skipped.
- **Run it locally:** `npm run sold:track -- --minutes 60` (add `--fetch-pace-ms 1000` to go faster) (state in `.sold-tracker/`, which it
  resumes from). To see a local run on the page, start the dev server with
  `SOLD_LISTINGS_FILE=.sold-tracker/sold-listings/<League>.json`.
- **Caveats:** a seller pulling an item for good looks the same as a sale. The trade API isn't in
  GGG's developer docs, and it's untested whether pathofexile.com accepts requests from GitHub's
  runners; if the workflow fails with a 403, run the tracker elsewhere. See `TODO.md`.

---

## Setup

1. Copy `.env.local.example` to `.env.local` and set:

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `SITE_PASSWORD` | yes | Shared password for the whole app (`proxy.ts`, `lib/site-auth.ts`). Not per-user auth. |
   | `POE_DATA_DIR` | for ingest | Folder with past leagues' CSV exports (see below). Default `../poe-pricing/data`. |
   | `PREDICTOR` | no | `xgb` (default), `formula` or `baseline`. |
   | `PREDICTIONS_REPO` | no | Repo whose `precompute-data` branch to read. Defaults to this repo. |

2. Build the history database: `npm run db:ingest`
3. Start the dev server: `npm run dev`

### Historical price data

Past leagues' prices aren't in the repo; download them once per machine.

1. Run `npx tsx scripts/download-league-history.ts`. It fetches every training league in
   `lib/training-leagues.ts` from [poe.ninja's exports](https://poe.ninja/poe1/data) into
   `<POE_DATA_DIR>/<League>/`. A league poe.ninja hasn't exported yet comes from the
   `precompute-data` branch's `history/` instead, which is less complete.
2. Run `npm run db:ingest`. It rebuilds `db/history.duckdb` from scratch each time.
   (`POE_INCLUDED_LEAGUES` overrides the league list for an experiment.)

---

## Updating data and the model

For the whole changeover in order (retrain, league swap, new items, deploys), see
[`docs/new-league.md`](docs/new-league.md).

### Retraining after a new league

Once a league ends and you've decided to train on it, run GitHub → Actions → **Retrain model** with
that league in "add_league" (`.github/workflows/retrain-model.yml`). It adds the league to
`lib/training-leagues.ts`, downloads the history, rebuilds `db/history.duckdb`, retrains on CPU,
runs the parity check and Mirage backtest, and opens a pull request. The PR's report shows:

- where each league's data came from and how many days it covers;
- the new model's validation scores next to the previous model's (stored in `predictor.json`);
- the check results.

It takes 1-3 hours. "drop_league" removes a league; both empty retrains on the same leagues. After
merging, the daily job reruns by itself; then run **Deploy to production**.

To do the same by hand (Python 3.11+ with `ml/requirements.txt`; set `XGB_DEVICE=cpu` without an
NVIDIA GPU):

```bash
npx tsx scripts/retrain-leagues.ts --add <League>   # or edit lib/training-leagues.ts
npx tsx scripts/download-league-history.ts && npm run db:ingest
npm run ml:export-features          # ~30 min: builds training rows with the app's own code
python ml/fit_production.py all     # validation report, writes lib/models/predictor.json
npm run ml:parity                   # checks the TypeScript model matches Python's output
npm run ml:backtest                 # replays Mirage through the app, per predictor
```

Then commit `lib/training-leagues.ts`, `db/history.duckdb` and `lib/models/predictor.json`. The
full new-league checklist (config, ingest, retrain, regenerating name maps, new poe.ninja
categories) is in `.claude/skills/new-league/SKILL.md`.

### New items and categories

A daily GitHub Action (`.github/workflows/check-new-items.yml`, running `scripts/check-new-items.ts`)
keeps the app's item lists current and opens a pull request when something changed:

- **poe.ninja categories** the app doesn't request yet are added to `lib/poe-ninja.ts` (exchange- or
  stash-priced, as poe.ninja itself says) with their page slug in `lib/ninja-link.ts`. poe.ninja has no
  category API, so the list is read from the config compiled into its site's JavaScript.
- **Currency Exchange names** are added to `lib/faustus.ts` (never removed, since markets open and
  close hour to hour), and `docs/faustus-mapping.md` is regenerated.
- **Divination cards** are regenerated from RePoE in `lib/divination-cards.ts`.

The PR description lists what needs a human: gold costs for new exchange items
(`lib/faustus-gold.ts`) and where new categories go in the category filter
(`lib/category-reliability.ts`). After merging, rerun the daily data job so the price snapshot picks
up new categories. Run it locally with `npx tsx scripts/check-new-items.ts` (`--dry-run` to only report).

To regenerate one list by hand (prints by default; `--write` writes the file):

| Command | Regenerates |
| --- | --- |
| `npx tsx scripts/generate-faustus-mapping.ts --write` | Currency Exchange name ↔ id map in `lib/faustus.ts` (replaces it with what's traded this hour) |
| `npx tsx scripts/generate-faustus-doc.ts` | `docs/faustus-mapping.md` |
| `npx tsx scripts/generate-divination-cards.ts --write` | `lib/divination-cards.ts` (stack sizes, rewards) |
| `npx tsx scripts/generate-disenchant-values.ts --write` | `lib/disenchant-values.ts` (each unique's dust value, from poedb; not part of the daily check) |

### Running the daily job by hand

GitHub → Actions → "Precompute predictions" → Run workflow, or `gh workflow run
precompute-predictions.yml`. Do this after changing any of the job's scripts. The
`precompute-check` skill covers checking the output.

---

## Deploying

The app deploys to Vercel as a normal Next.js project; nothing is trained in production.

- **Pushing to `master` doesn't deploy.** Run "Deploy to production" from the Actions tab
  (`.github/workflows/deploy-production.yml`). It calls a Vercel Deploy Hook, which needs a
  `VERCEL_DEPLOY_HOOK_URL` repo secret; see that workflow's comments for setup.
- **Git LFS:** `db/history.duckdb` (~72 MB) is stored with Git LFS, so enable LFS in the Vercel
  project. If every query fails, the build got an LFS pointer instead of the file.
- **Environment:** set `SITE_PASSWORD`. Set `PREDICTOR=baseline` to switch off the learned model
  without a code change.
- **Cost:** the model is a 4.5 MB JSON file; scoring ~10k items takes about 0.2 s of CPU.
- **Sold listing tracker:** runs in GitHub Actions, not Vercel. It publishes to the
  `sold-tracker-data` branch, which `vercel.json` keeps from deploying. Make its PR check (`check-searches`) a required
  status check on `master` so an over-limit search can't be merged.

---

## Working on this repo

- **`AGENTS.md`** (loaded via `CLAUDE.md`) holds the working rules: shared UI changes go in the
  shared row/card components, every UI change is checked at phone width, on-page text stays
  short, and README/skills are updated alongside the change.
- **Project skills** in `.claude/skills/`:
  - `verify-ui` runs the app and checks a change at desktop and phone width;
  - `precompute-check` checks or reruns the daily job;
  - `new-league` is the checklist for a league launch or end;
  - `sold-tracker` covers adding searches to, running, changing and debugging the sold listing
    tracker, and the mock-data preview;
  - `new-page` wires up a new page and holds the panel layout rules.
- **Path of Exile knowledge skills** in `poe-knowledge/` (economy, data sources, divination cards,
  league lifecycle, item categories, item tooltips, disenchanting), kept generic for use in other projects. See
  [`poe-knowledge/README.md`](poe-knowledge/README.md).

---

## Known limitations

- **poe.ninja's API is unofficial** and can change without notice. Categories have moved between
  its endpoints more than once (see the comments above `CURRENCY_OVERVIEW_TYPES` in
  `lib/poe-ninja.ts`).
- **Predictions aren't trade advice.** The model learned from a handful of past leagues and is measured on
  how well it ranks items, not on spreads, fees or whether an item can actually be sold. Items
  under 1c use the plain historical average.
- **Confidence describes history,** not the learned forecast, and varies with how many past
  leagues have data for an item.
- **New leagues need a human.** The league-swap PR must be reviewed and merged (the repo needs
  Settings → Actions → "Allow GitHub Actions to create and approve pull requests"). Choosing to
  train on a finished league means starting the Retrain model workflow and reviewing its PR.
- **Currency Exchange data is about 2 hours old** and gold costs are hand-transcribed.
- **The sold listing tracker uses the trade site's API,** which isn't in GGG's developer docs, and
  can't tell a sale from a seller taking an item off the market.
- **One item, several poe.ninja lines.** Base types have one line per item level or influence.
  The live price uses the first line while history averages them, so the two can differ.

---

## Project structure

### Pages and API

| Path | What it is |
| --- | --- |
| `app/page.tsx` | Flip Predictions (renders `components/dashboard.tsx`; code/routes still say "flip-suggestions") |
| `app/item/[category]/[key]/` | Item detail page |
| `app/currency_exchange_flip/`, `app/divination-cards/`, `app/dust-value/`, `app/sold-listings/`, `app/mirage-simulator/`, `app/current-league-tester/` | Other pages |
| `app/api/*/route.ts` | Read-only JSON endpoints (Route Handlers, not Server Actions) |
| `proxy.ts`, `lib/site-auth.ts` | Password gate |

### Components

| File | What it is |
| --- | --- |
| `app-header.tsx`, `global-search.tsx` | Header, page links and search |
| `item-history-row.tsx`, `item-history-card.tsx` | Shared table row (desktop) and card (mobile) every table uses |
| `price-history-chart.tsx` | The price chart |
| `item-detail-panel.tsx` | Item detail page content |
| `*-panel.tsx` | Each page's main panel |
| `mobile-sort-control.tsx` | Mobile sort and confidence/liquidity filter |
| `trade-site-link.tsx` | Trade site link icon |
| `poe-item-tooltip.tsx` | An item drawn like the game's tooltip (Sold Listings) |
| `ui/` | shadcn components |

### Predictions

| File | What it is |
| --- | --- |
| `lib/growth-ratios.ts` | Historical growth queries against DuckDB |
| `lib/prediction-features.ts`, `lib/prediction-model.ts` | Model inputs and evaluator; `lib/models/predictor.json` is the trained model |
| `lib/flip-suggestions.ts` | Ranks live prices by predicted growth (live path) |
| `lib/confidence.ts` | Confidence tiers |
| `lib/precomputed-predictions.ts` | Reads `predictions.json` from the `precompute-data` branch |
| `lib/predicted-suggestion.ts` | Rebuilds rows from that file (server and browser), and shifts a day-old file to today |
| `lib/horizon-fill.ts` | Fills missing days in the precomputed file |
| `lib/league-recency.ts`, `lib/league-day.ts` | Current league, release dates, league-day math |
| `lib/training-leagues.ts` | The finished leagues the model trains on |

### Prices and history

| File | What it is |
| --- | --- |
| `lib/poe-ninja.ts` | poe.ninja client, item keys, display names, poewiki links |
| `lib/price-snapshot.ts` | Reads/builds `prices.json` |
| `lib/faustus.ts`, `lib/faustus-gold.ts` | Currency Exchange client (Chaos and Divine markets per item) and gold costs |
| `lib/exchange-route.ts` | Picking a flip's buy/sell markets, and which currency to show profit in |
| `lib/liquidity.ts` | Liquidity tiers (exchange volume, and poe.ninja seller count for uniques) |
| `lib/trade-site.ts` | Official trade site search links |
| `lib/trade-query.ts`, `lib/trade-api.ts` | Trade site links decoded to their queries; the rate-limited trade API client (tracker only) |
| `lib/sold-tracker.ts`, `lib/sold-listings.ts`, `lib/sold-tracker-searches.ts` | The sold listing tracker's data model, sale rules and limits; reading its file for the page; reading `searches.md` |
| `lib/item-text.ts` | A stored item rebuilt as the game's Ctrl+C text (Sold Listings' Copy item) |
| `lib/price-history.ts` | Past-league history for the chart |
| `lib/current-league-history.ts` | Current league's history from the `precompute-data` branch CSVs |
| `lib/spark-backfill.ts` | Rebuilding missed days from poe.ninja's sparkline |
| `lib/item-detail.ts`, `lib/item-search.ts`, `lib/ninja-link.ts` | Detail page data, search, poe.ninja links |
| `lib/divination-cards.ts`, `lib/divination-flips.ts` | Card data (generated) and card flip scoring |
| `lib/disenchant-values.ts`, `lib/dust.ts`, `lib/dust-value.ts` | Dust values (generated), the dust formula, and the Dust Value ranking |
| `lib/db.ts`, `lib/api-response.ts` | DuckDB connection; JSON responses with cached, gzipped bytes |

### Scripts and tooling

| Path | What it is |
| --- | --- |
| `scripts/precompute-*.ts` | The daily job's three scripts; `raw-response-cache.ts` is their shared disk cache |
| `scripts/track-sold-listings.ts`, `sold-tracker/searches.md` | The sold listing tracker and the searches it follows |
| `scripts/publish-sold-tracker.sh` | Publishes the tracker's files to the `sold-tracker-data` branch (during and after a run) |
| `scripts/check-sold-searches.ts` | PR check: every search within the tracker's limits |
| `scripts/ingest-history.ts` | Builds `db/history.duckdb` from CSV exports |
| `scripts/check-current-league.ts`, `sync-current-league.ts` | League-swap check and fix |
| `scripts/check-new-items.ts` | Daily check for new items and poe.ninja categories (see [New items and categories](#new-items-and-categories)) |
| `scripts/generate-*.ts`, `scripts/generated-data.ts` | Regenerate the exchange map, its doc, card data and dust values; shared fetch/parse/write helpers |
| `scripts/export-training-features.ts`, `check-predictor-parity.ts`, `backtest-predictor.ts` | Model training export, parity check and backtest (`npm run ml:*`) |
| `scripts/retrain-leagues.ts`, `download-league-history.ts`, `retrain-report.ts` | The Retrain model workflow: edit the league list, fetch history, write the PR report |
| `scripts/backtest-mirage.ts`, `discover-*.ts` | One-off analyses |
| `ml/` | Offline Python for training and experiments; see `ml/README.md` |
