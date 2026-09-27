# PoE Flipper

A Path of Exile trading assistant. It predicts which items and currency are likely to gain value
over the next few days of the current league, and finds same-day flips on GGG's Currency Exchange
and in divination card turn-ins.

Built with Next.js, DuckDB (an embedded database holding past leagues' price history) and a small
learned model. Prices come from [poe.ninja](https://poe.ninja) and GGG's Currency Exchange API.

- [Pages](#pages)
- [How predictions work](#how-predictions-work)
- [The daily data job](#the-daily-data-job)
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
| **Flip Suggestions** | `/` | Items ranked by predicted growth over a chosen number of days (default 7). |
| **Currency Exchange Flip** | `/currency_exchange_flip` | Live buy/sell spreads on GGG's Currency Exchange, for flipping today. |
| **Divination Card Flips** | `/divination-cards` | Cards whose full stack costs less than the reward it turns into. |
| **Item detail** | `/item/<category>/<Item_Name>` | Everything the app knows about one item. |
| **Mirage league simulator** | `/mirage-simulator` | Replays a finished league to compare predictions with what happened. |
| **League tester** | `/current-league-tester` | Applies an item's historical growth to a price you type in. |

### Flip Suggestions

Pick a "Days ahead" value with the slider (1–30, instant) or type any number (beyond 30 triggers a
live calculation). Each row shows the current price, predicted price, change and a confidence tier.

- **Click a row** to expand a price chart across every past league, with markers for today and
  the target day, and the model's day-by-day forecast as a dotted line.
- **Click an item's name** to open its detail page. The small icon next to it opens poewiki.
- **Filters:** category, price range, search, and confidence tier (Low is hidden by default).
- **Chaos / Divine** toggle switches every price and ratio to that currency.

### Currency Exchange Flip

Buy/sell spreads from GGG's own exchange data, with trade volume, a liquidity tier and the gold
cost per trade. GGG's API is historical (about 2 hours old) and has no gold-cost field, so gold
costs are transcribed from community sources (`lib/faustus-gold.ts`).

### Divination Card Flips

Cost of a full stack (card price × stack size) versus the value of its reward, at today's prices.

Only cards with a single, fixed, priceable reward are included: a specific unique, a set amount of
currency, another card, or a specific plain item. Excluded:

- random rewards (a random unique of a class, a random gem roll);
- guaranteed-corrupted uniques, since poe.ninja has no separate corrupted price.

Magic/rare rewards are priced as their base type, ignoring affixes. Card data is generated from
RePoE's game files (`scripts/generate-divination-cards.ts`).

"Confidence" here means **liquidity**: the weaker of the two trades (buying the card, selling the
reward). It is usually low on an old league, because most card trading happens off the exchange.

### Item detail page

Reached from any item name, or from the header search. It shows:

- a **Days ahead** slider and a large price chart with the detailed forecast line;
- **Overview**: current price, predicted price, change, category, seller count;
- **Historical performance**: model prediction, past-leagues average, leagues used, share of
  leagues that rose, forecast precision (hover any label for a short explanation);
- **Recent momentum**: 1/3/6-day change, volatility and acceleration, from the same inputs the
  model uses;
- **Currency Exchange** (if the item trades there) and **Divination Card Flip** (if it's a card);
- links to the item's **poewiki** and **poe.ninja** pages.

On desktop the chart and Overview take the left 70%, and the other cards stack on the right.

### Shared across pages

- **Header:** app name, page links (a menu button on narrower screens), theme toggle and a
  **global search** box. Search suggests any item poe.ninja currently prices as you type, and
  opens its detail page. On a phone it's an icon that opens a full-width search.
- **Mobile:** tables become stacked cards, with a "Sort by" control and the confidence/liquidity
  filter above them. Nothing needs horizontal scrolling. The league tester doesn't have this yet.
- **Charts:** the current league has its own solid line up to today, joining the dotted forecast.
  On touch devices a tap shows the tooltip; the bar under the chart is for zooming.

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
checks poe.ninja for a new league and opens a pull request with the change
(`.github/workflows/check-current-league-swap.yml`). `npm run check-league` checks by hand;
`npm run league:sync` applies the change locally.

---

## The daily data job

`.github/workflows/precompute-predictions.yml` runs once a day (cron 00:10 UTC), on demand, and on
any push to `master` that changes the prediction code. It publishes to the **`data` branch**, which
never triggers a Vercel deploy. Each run replaces the branch with fresh files:

| File | Made by | Used for |
| --- | --- | --- |
| `prices.json` (~1.7 MB) | `scripts/precompute-price-snapshot.ts` | poe.ninja's whole price map (price, type, sparkline, seller count, poe.ninja id) plus which categories had listings. The detail page, search and Mirage simulator read this instead of calling poe.ninja. |
| `predictions.json` (~20 MB, ~5 MB gzipped) | `scripts/precompute-predictions.ts` | Every item's prediction for every "Days ahead" from 1 to 30. |
| `history/<League>/*.csv` | `scripts/precompute-price-history.ts` | The current league's daily prices, one CSV pair per month. Past leagues only exist in the database once they end. |

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
- **Caching.** The app re-checks the predictions and history files every 2 minutes and the price
  snapshot every 30 minutes, so a new day is picked up quickly.

---

## Setup

1. Copy `.env.local.example` to `.env.local` and set:

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `SITE_PASSWORD` | yes | Shared password for the whole app (`proxy.ts`, `lib/site-auth.ts`). Not per-user auth. |
   | `POE_DATA_DIR` | for ingest | Folder with past leagues' CSV exports (see below). Default `../poe-pricing/data`. |
   | `PREDICTOR` | no | `xgb` (default), `formula` or `baseline`. |
   | `PREDICTIONS_REPO` | no | Repo whose `data` branch to read. Defaults to this repo. |

2. Build the history database: `npm run db:ingest`
3. Start the dev server: `npm run dev`

### Historical price data

Past leagues' prices aren't in the repo; download them once per machine.

1. Download each league's export from [poe.ninja/poe1/data](https://poe.ninja/poe1/data).
2. Unzip into `<POE_DATA_DIR>/<League>/<League>.currency.csv` and `<League>.items.csv`, one folder
   per league, named exactly as poe.ninja names it.
3. You need the five training leagues in `scripts/ingest-history.ts`'s `PRODUCTION_LEAGUES`:
   **Mirage, Keepers, Mercenaries, Settlers, Phrecia 2.0**. (`POE_INCLUDED_LEAGUES` overrides the
   list for an experiment.)
4. Run `npm run db:ingest`. It rebuilds `db/history.duckdb` from scratch each time.

The **current league** needs no download: copy its folder from the `data` branch's `history/` into
`POE_DATA_DIR` once it ends. The ingest handles the monthly chunks.

---

## Updating data and the model

### Retraining after a new league

Needs Python 3.11+ with `ml/requirements.txt`. Training uses an NVIDIA GPU; set `XGB_DEVICE=cpu`
without one.

```bash
npm run ml:export-features          # ~30 min: builds training rows with the app's own code
python ml/fit_production.py all     # validation report, writes lib/models/predictor.json
npm run ml:parity                   # checks the TypeScript model matches Python's output
npm run ml:backtest                 # replays Mirage through the app, per predictor
```

Then commit `lib/models/predictor.json`. The full new-league checklist (config, ingest, retrain,
regenerating name maps, new poe.ninja categories) is in `.claude/skills/new-league/SKILL.md`.

### Regenerating generated files

| Command | Regenerates |
| --- | --- |
| `npx tsx scripts/generate-faustus-mapping.ts` | Currency Exchange name ↔ id map in `lib/faustus.ts` |
| `npx tsx scripts/generate-faustus-doc.ts` | `docs/faustus-mapping.md` |
| `npx tsx scripts/generate-divination-cards.ts` | `lib/divination-cards.ts` (stack sizes, rewards) |

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

---

## Working on this repo

- **`AGENTS.md`** (loaded via `CLAUDE.md`) holds the working rules: shared UI changes go in the
  shared row/card components, every UI change is checked at phone width, on-page text stays
  short, and README/skills are updated alongside the change.
- **Project skills** in `.claude/skills/`:
  - `verify-ui` runs the app and checks a change at desktop and phone width;
  - `precompute-check` checks or reruns the daily job;
  - `new-league` is the checklist for a league launch or end.
- **Path of Exile knowledge skills** in `poe-knowledge/` (economy, data sources, divination cards,
  league lifecycle, item categories), kept generic for use in other projects. See
  [`poe-knowledge/README.md`](poe-knowledge/README.md).

---

## Known limitations

- **poe.ninja's API is unofficial** and can change without notice. Categories have moved between
  its endpoints more than once (see the comments above `CURRENCY_OVERVIEW_TYPES` in
  `lib/poe-ninja.ts`).
- **Predictions aren't trade advice.** The model learned from five past leagues and is measured on
  how well it ranks items, not on spreads, fees or whether an item can actually be sold. Items
  under 1c use the plain historical average.
- **Confidence describes history,** not the learned forecast, and varies with how many past
  leagues have data for an item.
- **New leagues need a human.** The league-swap PR must be reviewed and merged (the repo needs
  Settings → Actions → "Allow GitHub Actions to create and approve pull requests"). Ingesting a
  finished league and retraining are manual.
- **Currency Exchange data is about 2 hours old** and gold costs are hand-transcribed.
- **One item, several poe.ninja lines.** Base types have one line per item level or influence.
  The live price uses the first line while history averages them, so the two can differ.

---

## Project structure

### Pages and API

| Path | What it is |
| --- | --- |
| `app/page.tsx` | Flip Suggestions (renders `components/dashboard.tsx`) |
| `app/item/[category]/[key]/` | Item detail page |
| `app/currency_exchange_flip/`, `app/divination-cards/`, `app/mirage-simulator/`, `app/current-league-tester/` | Other pages |
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
| `ui/` | shadcn components |

### Predictions

| File | What it is |
| --- | --- |
| `lib/growth-ratios.ts` | Historical growth queries against DuckDB |
| `lib/prediction-features.ts`, `lib/prediction-model.ts` | Model inputs and evaluator; `lib/models/predictor.json` is the trained model |
| `lib/flip-suggestions.ts` | Ranks live prices by predicted growth (live path) |
| `lib/confidence.ts` | Confidence tiers |
| `lib/precomputed-predictions.ts` | Reads `predictions.json` from the `data` branch |
| `lib/predicted-suggestion.ts` | Rebuilds rows from that file (server and browser), and shifts a day-old file to today |
| `lib/horizon-fill.ts` | Fills missing days in the precomputed file |
| `lib/league-recency.ts`, `lib/league-day.ts` | Current league, release dates, league-day math |

### Prices and history

| File | What it is |
| --- | --- |
| `lib/poe-ninja.ts` | poe.ninja client, item keys, display names, poewiki links |
| `lib/price-snapshot.ts` | Reads/builds `prices.json` |
| `lib/faustus.ts`, `lib/faustus-gold.ts` | Currency Exchange client and gold costs |
| `lib/liquidity.ts` | Liquidity tiers |
| `lib/price-history.ts` | Past-league history for the chart |
| `lib/current-league-history.ts` | Current league's history from the `data` branch CSVs |
| `lib/item-detail.ts`, `lib/item-search.ts`, `lib/ninja-link.ts` | Detail page data, search, poe.ninja links |
| `lib/divination-cards.ts`, `lib/divination-flips.ts` | Card data (generated) and card flip scoring |
| `lib/db.ts`, `lib/api-response.ts` | DuckDB connection; JSON responses with cached, gzipped bytes |

### Scripts and tooling

| Path | What it is |
| --- | --- |
| `scripts/precompute-*.ts` | The daily job's three scripts; `raw-response-cache.ts` is their shared disk cache |
| `scripts/ingest-history.ts` | Builds `db/history.duckdb` from CSV exports |
| `scripts/check-current-league.ts`, `sync-current-league.ts` | League-swap check and fix |
| `scripts/generate-*.ts` | Regenerate the exchange map, its doc and card data from RePoE |
| `scripts/export-training-features.ts`, `check-predictor-parity.ts`, `backtest-predictor.ts` | Model training export, parity check and backtest (`npm run ml:*`) |
| `scripts/backtest-mirage.ts`, `discover-*.ts`, `backfill-current-league-history.ts` | One-off analyses and a one-time history backfill |
| `ml/` | Offline Python for training and experiments; see `ml/README.md` |
