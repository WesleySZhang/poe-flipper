# PoE Flipper

## How it works

- **Flip suggestions**: ranks items/currency by their forecast growth from a chosen day
  of the current league over a chosen number of days. The forecast starts from how much
  each item historically grew over that stretch of past leagues (a local DuckDB database
  built from historical poe.ninja price exports; every past league counts equally - see
  `lib/league-recency.ts`) and is then adjusted by a learned model - see **Learned
  forecast** below - against today's live price. The current league and its start date are hardcoded in
  `lib/league-recency.ts` (`CURRENT_LEAGUE`) and need updating by hand each time a new
  challenge league launches - though this is now caught and fixed automatically rather
  than requiring someone to notice (see **Known limitations** below for how). `npm run
  check-league` still exists for an instant manual check (read-only, just reports
  staleness) and `npm run league:sync` for a manual write (same edit the scheduled job's
  pull request makes, applied directly instead), for whenever you don't want to wait for
  the next scheduled run.
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
  history rather than trusting the ratio blind (`components/price-history-chart.tsx`). The
  currently active league also gets its own real, solid line up to today - built from the
  daily precomputed snapshots below rather than the past-league database, which only ever
  holds finished leagues (`lib/current-league-history.ts`) - drawn in the same color as,
  and connecting directly into, the dashed forecast line, so the two read as one continuous
  "actually happened, then predicted" story instead of two unrelated series. That line
  always reaches all the way to today even if the daily snapshot for today hasn't landed
  yet (see **Daily precomputed data** below) - it stitches on today's own already-fetched
  live price as its last point in that case, so there's never a visible gap between the
  real history and the forecast regardless of the snapshot job's timing. On the Flip
  Suggestions page this also draws the model's own day-by-day forecast for every
  "Days ahead" value from 1-30, not just whichever one is currently selected, extending
  with one final straight segment past day 30 if the selected duration goes further -
  fetched lazily on row expand (`app/api/flip-suggestion-curve`), straight from today's
  precomputed file. Deliberately no live fallback for an item missing from that file (an
  earlier version reran the full cross-sectional model once per duration - 30 full
  recomputes - which turned out to be a common, not rare, case and could stall the whole
  app for tens of seconds under load): a missing/stale file or an item absent from it just
  means no detailed curve, and the chart already draws its plain two-point line (today's
  price to the one selected duration's own prediction) in that case. The chart's own axis text,
  margins and default zoom level adapt for a narrow/mobile screen (same fixed SVG
  `viewBox`, just bigger text and a tighter default window around today/target so it stays
  legible without pinch-zooming). On a touch device, tapping the chart always shows/moves
  the hover tooltip instead of ever starting a drag-to-zoom - touch has no separate "hover"
  the way a mouse does, so without this a tap could be indistinguishable from the start of
  a zoom drag; the range brush below the chart is the deliberate way to zoom on touch.
- **Per-item detail page** (`/item/[category]/[key]`, `components/item-detail-panel.tsx`):
  every item's name in a table (`ItemHistoryRow`/`ItemHistoryCard`) links here - a
  deliberate second action separate from the row's own click-to-expand, so clicking the
  name navigates while clicking elsewhere on the row still just opens the inline preview.
  URL segments use `_` for spaces (`itemDetailUrlKey`/`parseItemDetailUrlKey` in
  `lib/poe-ninja.ts`) rather than a raw `%20`. Has its own "Days ahead" slider (reusing the
  same client-side precomputed reconstruction the main table uses, so it's just as
  instant); on desktop the price history chart takes the left 70% of the page below the
  slider and Overview, with every other card (Historical performance, Recent momentum,
  Currency Exchange, Divination Card Flip) stacked in the remaining 30% on the right,
  falling back to a single full-width column on mobile. Shows 1/3/6-day price momentum
  derived from the same sparkline inputs the learned model itself sees
  (`lib/prediction-features.ts`, via `lib/item-detail.ts`); for Faustus-tradeable
  currency, the full buy/sell spread/profit/volume/stock/gold cost/liquidity tier; and for
  a divination card, its own stack-flip economics (cost, reward, profit, confidence),
  reusing `lib/divination-flips.ts`. Today's live price (`ItemDetail.currentChaosValue`)
  is shown independently of whether a prediction exists for the selected duration - an
  item whose past leagues are too short to support a longer forecast still has a real
  price worth showing, it just has no prediction at that specific "Days ahead" value.
  Also links out to the item's poewiki.net page (`lib/poe-ninja.ts`'s `poeWikiUrl` - a
  plain name-to-URL string transform, not a fetched/generated mapping, so it needs no
  upkeep as new items appear each league; poewiki.net is independently hosted, not Fandom -
  confirmed live). The same poewiki link also appears as a small icon next to the name in
  every table row, for a quick cross-check without leaving the table.
- **Category filters**: tables can be filtered by category - an item's BaseType, or
  "Currency" for every currency row - built from whatever categories are actually
  present in the current results.
- **Mobile layout**: on a narrow screen, every table except the current league tester
  (Flip Suggestions, Mirage simulator, Currency Exchange Flip, Divination Card Flips)
  becomes a stacked list of cards instead (`components/item-history-card.tsx`) - every
  column's value is still visible, just laid out vertically instead of sideways, so
  nothing needs horizontal scrolling to read. Tapping a card expands the same price
  history chart a table row would, except on Currency Exchange Flip/Divination Card Flips,
  which rank off the current market snapshot rather than a historical trend and so have no
  chart to expand (`expandable={false}` on `ItemHistoryRow`/`ItemHistoryCard`). Sorting by
  a column also works on mobile - the desktop table header's click-to-sort disappears with
  the table itself, so a `MobileSortControl` (column picker + direction toggle) sits above
  the card list instead, driving the same sort state a header click would. The current
  league tester doesn't have this treatment yet - see `TODO.md`.
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
  single, deterministic, currently-priced unique item, plain named item (a specific
  Scarab/Fragment with no randomness at all, e.g. "Sulphite Scarab"), currency amount, or
  other card are included - cards with a randomized reward (a roll, a random item of a
  category) are excluded, since their true value can't be computed from a single number.
  This also excludes a guaranteed-corrupted unique reward (Headhunter, Kaom's Heart, ...) -
  the item itself is guaranteed, but a corrupted unique typically trades for meaningfully
  LESS than its pristine price, and poe.ninja doesn't track a separate corrupted price
  point to measure that real gap from. A Magic/Rare-rarity reward (e.g. a rare "Six-Link
  Astral Plate") IS included, but deliberately priced as if it were just its plain base
  type, ignoring whatever affixes actually get rolled onto it - a real simplification, not
  an exact number, but usually close since the base itself is most of a reward like this
  one's value (`lib/divination-cards.ts`, generated from RePoE's game data by
  `scripts/generate-divination-cards.ts`; `lib/divination-flips.ts` does the live
  scoring). Confidence here is the weaker of the two legs' live trade liquidity (buying
  the card, selling the reward), not the historical-reliability score used elsewhere - a
  low reading is expected and not a bug on an older, quieter league, since most card
  trading happens off GGG's Currency Exchange (the confidence signal's only data source)
  entirely; it should read higher on a fresh league with more active trading.
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
  the nav row's position) stays identical everywhere. The nav row wraps onto multiple
  lines on a narrow screen rather than overflowing the page horizontally.
- **Data store**: [DuckDB](https://duckdb.org) (embedded, columnar, great for analytical
  queries over large CSV history) - no external database server required.
- **Daily precomputed data** (`scripts/precompute-predictions.ts`,
  `scripts/precompute-price-history.ts`): a GitHub Actions job
  (`.github/workflows/precompute-predictions.yml`, cron `10 0 * * *` - shortly after UTC
  midnight, taking about 2 minutes end to end) runs once a day and publishes to this
  repo's `data` branch, which is configured (`vercel.json`) to never trigger a Vercel
  deployment. It also runs automatically on any push to `master` that touches the
  prediction algorithm itself (`lib/flip-suggestions.ts`, `lib/prediction-model.ts`,
  `lib/models/predictor.json`, and the rest of that call chain - see the workflow's own
  `push.paths` filter for the exact list), so a merged algorithm change doesn't sit stale
  in production for up to a day waiting on the next scheduled run - plus `workflow_dispatch`
  for triggering it by hand any other time. Each run fully replaces `predictions.json` (a
  disposable snapshot, not appended to) and today's row in the price-history CSVs (dropped
  and re-added, so re-running the same day is safe). It does two things: (1) runs the
  learned model once for every "Days ahead"
  deployment. It does two things: (1) runs the learned model once for every "Days ahead"
  value, so a page load reads a ready-made result (`lib/precomputed-predictions.ts`)
  instead of waiting on a live model run, falling back to computing live if that file is
  missing or stale; (2) snapshots today's live prices into a growing, per-league CSV pair
  matching `scripts/ingest-history.ts`'s own format (see **Historical price data** below) -
  the currently active league otherwise has no daily price history at all until it ends
  and someone manually downloads poe.ninja's export. The Flip Suggestions page fetches
  this whole file once (`/api/flip-suggestions/precomputed`) and reconstructs every
  duration's rows itself in the browser (`lib/predicted-suggestion.ts`, shared with the
  server so both sides stay in sync) - so its "Days ahead" slider, bounded to the
  precomputed 1-30 day range, updates the table live while being dragged with zero further
  network requests; a separate exact-entry number input allows any value beyond that too,
  at the cost of a live compute for that one request. The app's own notion of "what day of
  the league is it" (`lib/league-day.ts`'s `currentLeagueDay`) deliberately lags 20 minutes
  behind the real UTC day rollover, so nothing asks for "today"'s data before this job has
  had time to actually publish it - see that file's own comment for the reasoning and the
  timing this is tuned against. Both the precomputed-predictions and current-league-history
  in-memory fetch caches (`lib/precomputed-predictions.ts`, `lib/current-league-history.ts`)
  use a short (2-minute) TTL for the same reason: picking up a freshly-published day
  quickly rather than serving an already-warm instance's stale fetch for longer.

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

**The currently active league doesn't need a manual download at all** - the scheduled job described
above (`scripts/precompute-price-history.ts`) has already been snapshotting its live prices daily
onto the `data` branch, one CSV pair per calendar month
(`<League>/<League>.currency.YYYY-MM.csv`/`<League>/<League>.items.YYYY-MM.csv` - chunked by month
since one file for a whole league would otherwise grow past GitHub's 100MB push limit). Copy that
league's folder from the `data` branch into `POE_DATA_DIR` alongside the others and run
`npm run db:ingest` the same as any other league - `ingest-history.ts`'s file matching already
handles both the chunked convention and a real one-file poe.ninja export the same way.

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

- **Pushing to `master` no longer auto-deploys** (`vercel.json`'s `git.deploymentEnabled.master:
  false`, same mechanism already used to keep the `data` branch from ever deploying). Deploying is
  a deliberate, separate step: trigger `.github/workflows/deploy-production.yml` by hand (Actions
  tab -> "Deploy to production" -> Run workflow), which hits a Vercel Deploy Hook - set up once via
  Vercel dashboard -> Settings -> Git -> Deploy Hooks (branch `master`) and a matching
  `VERCEL_DEPLOY_HOOK_URL` repo secret; see that workflow's own comment for the exact steps. It
  always deploys whatever the latest commit on `master` happens to be at the moment it's run, not
  necessarily anything freshly pushed.
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

See also [`TODO.md`](TODO.md) for known gaps and ideas that aren't implemented yet (not a
schedule or a promise - just a running list).

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
- The current league is still hardcoded (see above), but swapping it is no longer a
  fully manual chore: a scheduled job (`.github/workflows/check-current-league-swap.yml`,
  `scripts/sync-current-league.ts`) checks poe.ninja's live leagues list daily and, on a
  mismatch, opens a pull request with the exact edit already made (the new league's
  release date plus the `CURRENT_LEAGUE` flip) - review and merge it and the live site
  picks up the new league on the next deploy. It stops short of pushing straight to
  master itself on purpose: this constant feeds live economy data to every visitor, and a
  bad detection (a poe.ninja hiccup, an unexpected reordering of that endpoint) should get
  a human's eyes before it deploys. Deciding whether/when to start *training* on the new
  league (ingesting it, retraining the model) is separate and still fully manual, same as
  always - see **Historical price data** and **Refreshing the learned model** below.
  **One-time repo setup this relies on**: Settings -> Actions -> General -> Workflow
  permissions -> "Allow GitHub Actions to create and approve pull requests", otherwise the
  job can detect a swap but can't open the PR for it.
- GGG's Currency Exchange API is purely historical (roughly 2 hours stale) and has no
  gold-cost field at all - the Currency Exchange Flip page's buy/sell spreads and gold
  costs are the best available approximation, not a live order book.

## Project structure

- `TODO.md` - known gaps and unimplemented ideas, tracked outside this README since they're not
  "how it works" - see **Known limitations** above.
- `scripts/ingest-history.ts` - bulk-loads historical CSVs into `db/history.duckdb`.
- `scripts/backtest-mirage.ts` - CLI backtest of the model against the Mirage holdout.
- `scripts/discover-*.ts` - one-off analyses behind past modeling decisions (peer-group
  shrinkage, training-league selection, error budget) - not part of the running app.
- `scripts/backfill-current-league-history.ts` - one-time script that reconstructs a
  currently-active league's early days of price history from poe.ninja's own live 7-point
  sparkline, for a league too new to have much real daily-collected history yet; not part
  of the running app or the daily precompute job.
- `scripts/generate-faustus-*.ts` - regenerates the Currency Exchange name/id mapping
  and its doc from RePoE data.
- `scripts/generate-divination-cards.ts` - regenerates `lib/divination-cards.ts` (stack
  size + reward per card) from RePoE data.
- `scripts/check-current-league.ts` - compares the hardcoded `CURRENT_LEAGUE` against
  poe.ninja's live leagues list; run via `npm run check-league`.
- `scripts/sync-current-league.ts` - same check, but on a mismatch actually rewrites
  `lib/league-recency.ts` with the fix; run via `npm run league:sync`, or automatically
  daily by `.github/workflows/check-current-league-swap.yml` (which opens the result as a
  pull request rather than committing it directly - see **Known limitations** above).
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
- `lib/current-league-history.ts` - the active league's own real price history, read
  straight from the daily precomputed CSV snapshots on the `data` branch (see **Daily
  precomputed data** above) rather than the past-league database - appended onto
  `lib/price-history.ts`'s results as the chart's solid "up to today" line.
- `lib/flip-suggestions.ts` - ranks live prices by projected growth.
- `lib/mirage-simulator.ts` - backs the `/mirage-simulator` testing page.
- `lib/faustus.ts` - GGG Currency Exchange client (live prices and buy/sell spreads).
- `lib/faustus-gold.ts` - gold cost per item on the Currency Exchange.
- `lib/liquidity.ts` - liquidity tiering shared by Currency Exchange spreads and
  Divination Card Flips' Confidence column.
- `lib/divination-cards.ts` - generated card metadata (stack size, reward); see
  `scripts/generate-divination-cards.ts` above.
- `lib/divination-flips.ts` - live scoring for the Divination Card Flips page.
- `lib/item-detail.ts` - one item's live "extras" a table row doesn't show (seller count,
  raw sparkline/momentum, Faustus spread) - see **Per-item detail page** above.
- `lib/site-auth.ts` / `proxy.ts` - the shared-password login gate.
- `app/api/*/route.ts` - read-only data endpoints used by the UI (deliberately Route
  Handlers, not Server Actions - see the comment in `mirage-simulation/route.ts`).
- `app/currency_exchange_flip`, `app/divination-cards`, `app/mirage-simulator`,
  `app/current-league-tester` - the app's secondary pages; the dashboard (flip
  suggestions) lives at `/`. `app/item/[category]/[key]` is the per-item detail page -
  see its own section above for the URL scheme.
- `components/app-header.tsx` - the shared nav header every page renders; see
  **Navigation** above.
- `components/item-history-row.tsx` / `item-history-card.tsx` - the shared desktop-table-
  row/mobile-card components every table's items render through (click-to-expand chart,
  the detail-page link, the poewiki link).
- `components/mobile-sort-control.tsx` - the column-picker + direction-toggle control that
  stands in for a desktop `SortableHeader` click once the table itself is replaced by the
  mobile card list.
- `lib/api-response.ts` - JSON response helpers shared by every `app/api/*/route.ts`;
  `cachedJsonResponse` also caches the serialized (and gzipped) response bytes, not just
  the underlying data, for the handful of routes whose payload is large enough that
  `JSON.stringify`/gzip alone is a meaningful, repeat-request cost.
- `components/item-detail-panel.tsx` - the per-item detail page's actual content.
- `components/*.tsx` - the rest of the dashboard UI (category/confidence/liquidity
  filters, price history chart), the Currency Exchange Flip panel, the Divination Card
  Flips panel, and the Mirage simulator panel.
