# PoE Flipper

## How it works

- **Flip suggestions**: ranks items/currency by their forecast growth from a chosen day
  of the current league over a chosen number of days. The forecast starts from how much
  each item historically grew over that stretch of past leagues (a local DuckDB database
  built from historical poe.ninja price exports; every past league counts equally - see
  `lib/league-recency.ts`) and is then adjusted by a learned model - see **Learned
  forecast** below - against today's live price. The current league and its start date are hardcoded in
  `lib/league-recency.ts` (`CURRENT_LEAGUE`) and need updating by hand each time a new
  challenge league launches. `npm run check-league` compares it against poe.ninja's own
  live leagues list and warns if it's gone stale (see below) - run this whenever you
  suspect a new league has launched, then update `CURRENT_LEAGUE` by hand.
- **Learned forecast** (`lib/prediction-model.ts`, `lib/prediction-features.ts`): the
  historical average alone is a weak predictor - in a backtest it ranked late-league items
  about as well as a coin flip. The forecast therefore also uses (1) how today's price
  compares with what the item cost on the same day of past leagues (expensive items tend
  to fall, cheap ones to rise) and (2) poe.ninja's 7-day price sparkline (currency
  momentum tends to continue, items' does not). Two interchangeable models are shipped in
  `lib/models/predictor.json` (4.5 MB): gradient-boosted trees (default) and a small
  linear formula per league-day bucket. Chosen with the optional `PREDICTOR` env var:
  `xgb` (default), `formula`, or `baseline` (the original plain average); a missing model
  file falls back automatically. Replaying the finished Mirage league with a model that
  never saw it: rank correlation 0.185 -> 0.334, share of top-decile picks that gained
  61.7% -> 72.8% (`npm run ml:backtest`). Training, validation and every experiment are
  documented in [`ml/README.md`](ml/README.md); the Python there is offline tooling and
  is not part of the deployed app.
- **Confidence scoring**: each suggestion also gets a confidence tier (High/Medium/Low)
  based on how reliably that item has actually gained in past leagues, not just how big
  the predicted gain is - see `lib/confidence.ts`. A separate "forecast precision" note in
  the same badge's hover text (chaos mode, learned-forecast predictor only) says how wide
  the model's *own* uncertainty band is around this specific number - a deliberately
  distinct question from the tier, which is answered by a second, independent pair of
  quantile models trained alongside the point forecast (see `ml/README.md`). The Currency
  Exchange Flip and Divination Card Flips pages show a differently-named "Confidence"
  column instead, based on live trade liquidity rather than historical reliability - see
  their own sections below and `lib/liquidity.ts`.
- **Price history charts**: click any row to expand a chart of that item's price across
  every past league used for training, with markers for the current day and the
  prediction's target day - lets you sanity-check a prediction against the real shape of
  history rather than trusting the ratio blind (`components/price-history-chart.tsx`).
- **Category filters**: tables can be filtered by category - an item's BaseType, or
  "Currency" for every currency row - built from whatever categories are actually
  present in the current results.
- **Currency Exchange Flip** (`/currency_exchange_flip`): a separate, non-predictive
  page showing live buy/sell spreads on GGG's in-game Currency Exchange ("Faustus"),
  for same-day flipping rather than long-range prediction. Includes a liquidity signal
  and the gold cost of trading each item (`lib/faustus.ts`, `lib/faustus-gold.ts`) -
  GGG's exchange API has no gold-cost field, so those numbers are transcribed by hand
  from community sources (mostly exact; a handful of items fall back to a range
  estimate - see the comments in `lib/faustus-gold.ts`).
- **Divination Card Flips** (`/divination-cards`): ranks divination cards by the profit
  from buying a full stack (poe.ninja's live card price x the card's stack size) and
  turning it in for its reward, at today's live prices. Only cards whose reward is a
  single, deterministic, currently-priced unique item, currency amount, or other card are
  included - cards with a randomized reward (a roll, a corruption, a random item of a
  category) are excluded, since their true value can't be computed from a single number
  (`lib/divination-cards.ts`, generated from RePoE's game data by
  `scripts/generate-divination-cards.ts`; `lib/divination-flips.ts` does the live
  scoring). Confidence here is the weaker of the two legs' live trade liquidity (buying
  the card, selling the reward), not the historical-reliability score used elsewhere.
- **Mirage simulator** (`/mirage-simulator`): a testing page that replays the model
  against the Mirage league - which is always excluded from the historical averages - so
  you can pick a day and duration and see the model's prediction next to what actually
  happened. (The shipped learned model was trained on all five past leagues including
  Mirage, so this page flatters it; `npm run ml:backtest` does the honest version with a
  model trained without Mirage.)
- **Current league tester** (`/current-league-tester`): look up a single item/currency
  by name and apply its historical growth ratio to a price you type in. It uses the
  historical ratio only, not the learned forecast (it has no live price to work from).
- **Navigation** (`components/app-header.tsx`): every page shares one header - a button
  per top-level page plus a "Testing" dropdown grouping the Mirage simulator and current
  league tester (opens on hover or click). The current page's own button is highlighted;
  none of the pages carry a description under their title, so the header's height (and so
  the nav row's position) stays identical everywhere.
- **Data store**: [DuckDB](https://duckdb.org) (embedded, columnar, great for analytical
  queries over large CSV history) - no external database server required.

## Setup

1. Copy `.env.local.example` to `.env.local` and fill in:
   - `POE_DATA_DIR` - folder containing `<League>/<League>.currency.csv` and
     `<League>.items.csv` exports (semicolon-delimited, columns
     `League;Date;Get;Pay;Value;Confidence` for currency and
     `League;Date;Id;Type;Name;BaseType;Variant;Links;Value;Confidence` for items) - see
     **Historical price data** below for where these come from and how to lay them out.
   - `SITE_PASSWORD` - a shared password gating the whole app (see `proxy.ts` /
     `lib/site-auth.ts`). Not per-user auth, just a gate since this is shared with a
     handful of people. Required - unset, the login page rejects every attempt.
   - `PREDICTOR` - optional: `xgb` (default), `formula` or `baseline`, see above.
2. Ingest historical data into DuckDB:
   ```bash
   npm run db:ingest
   ```
3. Run the dev server:
   ```bash
   npm run dev
   ```

### Historical price data

The app trains and backtests on real historical prices, not live poe.ninja data alone - this data
isn't included in the repo (it's a per-league CSV export, not something to commit) and has to be
downloaded once per machine before `npm run db:ingest` has anything to ingest.

1. Go to [poe.ninja/poe1/data](https://poe.ninja/poe1/data) and download the currency and item
   history export for each league below (a zip per league containing that league's currency and
   item CSVs). This is a manual, per-league download - poe.ninja doesn't expose these as a stable
   API endpoint.
2. Unzip each league's export and arrange the CSVs under `POE_DATA_DIR` as
   `<POE_DATA_DIR>/<League>/<League>.currency.csv` and `<POE_DATA_DIR>/<League>/<League>.items.csv`
   - one subfolder per league, named exactly as poe.ninja names the league. `POE_DATA_DIR` can be
   any folder on disk - the suggested default (`../poe-pricing/data`) is just a sibling folder next
   to this repo, outside it entirely, so there's nothing to gitignore or commit; nothing about the
   ingest script assumes a specific machine or location, only the folder layout above.
3. The production model is trained on five specific leagues - `scripts/ingest-history.ts`'s
   `PRODUCTION_LEAGUES` - so at minimum you need exports for: **Mirage, Keepers, Mercenaries,
   Settlers, Phrecia 2.0**. (`POE_INCLUDED_LEAGUES`, a comma-separated env var, overrides this list
   for an experiment without editing the script - see its comment.)
4. Run `npm run db:ingest` (step 2 above) once the folders are in place. It rebuilds
   `db/history.duckdb` from scratch every run, so re-download and re-ingest whenever you want to
   pick up a league poe.ninja has since finished.

### Refreshing the learned model

After ingesting a new league, retrain (needs Python 3.11+ with the packages in
`ml/requirements.txt`; training uses an NVIDIA GPU by default - set `XGB_DEVICE=cpu`
without one):

```bash
npm run ml:export-features          # ~30 min: training rows, built by the app's own TypeScript
python ml/fit_production.py all     # validation report + writes lib/models/predictor.json
npm run ml:parity                   # TypeScript runtime reproduces Python's predictions
npm run ml:backtest                 # replay Mirage through the app's simulator, per predictor
```

Commit `lib/models/predictor.json`. Details, and why features are built in TypeScript
rather than Python, are in [`ml/README.md`](ml/README.md).

## Deploying to Vercel

The app deploys as a normal Next.js project; nothing is built or trained in production.

- `db/history.duckdb` (~72 MB) is committed through **Git LFS** (see `.gitattributes`), so the
  Vercel project needs its Git LFS setting enabled - if the database looks tiny or every
  query fails, the build checked out an LFS pointer instead of the file. `next.config.ts`
  force-includes DuckDB's native binaries in the function bundle, and `lib/db.ts` opens the
  database read-only because a function's filesystem is read-only.
- Set `SITE_PASSWORD` under the project's Environment Variables; `PREDICTOR` is optional
  (set it to `baseline` to revert to the original forecast without a code change).
- The learned model is a plain 4.5 MB JSON file, so it adds nothing to Git LFS storage or
  bandwidth; scoring ~10k items takes roughly 0.2 s of CPU per request (repeat requests
  are cached in memory).

## Known limitations

- poe.ninja's economy/pricing endpoints aren't part of any officially documented public
  API and may change or break without notice, though poe.ninja does publish a small API
  reference (poe.ninja/docs/api) covering some of what's used here, including the
  leagues-list endpoint `npm run check-league` relies on.
- Flip suggestions are a statistical forecast, not financial/trade advice. The learned
  model is trained on only five past leagues (the current one is a sixth, different
  economy) and its accuracy is measured as *ranking quality* - it says nothing about
  spreads, fees or whether a cheap item can actually be traded. Live poe.ninja sparklines
  are noisier than the cleaned stored history the model learned from, and no live
  league's outcomes have been scored against its forecasts yet. Items under 1c keep the
  plain historical ratio. The confidence tier still describes how consistently an item
  gained in past leagues, not the learned forecast, and varies with how many past leagues
  have data for it.
- The current league is hardcoded (see above) rather than fully auto-detected - poe.ninja
  does expose a live leagues list, but switching `CURRENT_LEAGUE` also requires adding
  the new league's release date and deciding whether/when to start training on it, which
  isn't something to do unattended.
- GGG's Currency Exchange API is purely historical (roughly 2 hours stale) and has no
  gold-cost field at all - the Currency Exchange Flip page's buy/sell spreads and gold
  costs are the best available approximation, not a live order book.

## Project structure

- `scripts/ingest-history.ts` - bulk-loads historical CSVs into `db/history.duckdb`.
- `scripts/backtest-mirage.ts` - CLI backtest of the model against the Mirage holdout.
- `scripts/discover-*.ts` - one-off analyses behind past modeling decisions (peer-group
  shrinkage, training-league selection, error budget) - not part of the running app.
- `scripts/generate-faustus-*.ts` - regenerates the Currency Exchange name/id mapping
  and its doc from RePoE data.
- `scripts/generate-divination-cards.ts` - regenerates `lib/divination-cards.ts` (stack
  size + reward per card) from RePoE data.
- `scripts/check-current-league.ts` - compares the hardcoded `CURRENT_LEAGUE` against
  poe.ninja's live leagues list; run via `npm run check-league`.
- `scripts/export-training-features.ts`, `check-predictor-parity.ts`,
  `backtest-predictor.ts` - the learned model's training-data export, TypeScript/Python
  parity check and out-of-sample Mirage replay (`npm run ml:*`);
  `export-backtest-baseline.ts` feeds the experiments in `ml/`.
- `ml/` - offline Python for the learned model: experiments, validation, and
  `fit_production.py`, which writes `lib/models/predictor.json`. See `ml/README.md`.
- `lib/db.ts` - shared DuckDB connection.
- `lib/poe-ninja.ts` - live poe.ninja price client (with caching), including each item's
  7-day sparkline. Falls back to poe.ninja's Currency Exchange-backed overview for any
  category whose stash-listing scrape returns no data (most non-Currency/Fragment
  categories did, as of 2026-09-20 - see the comment above `CURRENCY_OVERVIEW_TYPES`).
- `lib/growth-ratios.ts` - core historical growth-ratio queries.
- `lib/prediction-features.ts` - the one implementation of the learned model's inputs,
  shared by the live app, the Mirage simulator and the training export.
- `lib/prediction-model.ts` / `lib/models/predictor.json` - tree/formula evaluator and
  the trained model; also the `PREDICTOR` switch.
- `lib/history-now.ts` - reads a past league's stored prices in the same shape as the live
  feed (price now + 7-day sparkline), for replays and training rows.
- `lib/league-recency.ts` - per-league recency weighting, and the current league.
- `lib/confidence.ts` - confidence-tier scoring for a prediction.
- `lib/price-history.ts` - per-item price history across past leagues, for the chart.
- `lib/flip-suggestions.ts` - ranks live prices by projected growth.
- `lib/mirage-simulator.ts` - backs the `/mirage-simulator` testing page.
- `lib/faustus.ts` - GGG Currency Exchange client (live prices and buy/sell spreads).
- `lib/faustus-gold.ts` - gold cost per item on the Currency Exchange.
- `lib/liquidity.ts` - liquidity tiering shared by Currency Exchange spreads and
  Divination Card Flips' Confidence column.
- `lib/divination-cards.ts` - generated card metadata (stack size, reward); see
  `scripts/generate-divination-cards.ts` above.
- `lib/divination-flips.ts` - live scoring for the Divination Card Flips page.
- `lib/site-auth.ts` / `proxy.ts` - the shared-password login gate.
- `app/api/*/route.ts` - read-only data endpoints used by the UI (deliberately Route
  Handlers, not Server Actions - see the comment in `mirage-simulation/route.ts`).
- `app/currency_exchange_flip`, `app/divination-cards`, `app/mirage-simulator`,
  `app/current-league-tester` - the app's secondary pages; the dashboard (flip
  suggestions) lives at `/`.
- `components/app-header.tsx` - the shared nav header every page renders; see
  **Navigation** above.
- `components/*.tsx` - dashboard UI (flip suggestions, category/confidence/liquidity
  filters, price history chart), the Currency Exchange Flip panel, the Divination Card
  Flips panel, and the Mirage simulator panel.
