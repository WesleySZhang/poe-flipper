# PoE Flipper

An unofficial Path of Exile companion that suggests items to flip, based on historical
league economy data.

> This product isn't affiliated with or endorsed by Grinding Gear Games in any way.

## How it works

- **Flip suggestions**: ranks items/currency by how much they historically grew from a
  chosen day of the current league over a chosen number of days (weighted so recent
  leagues count far more than old ones - see `lib/league-recency.ts`), using a local
  DuckDB database built from historical poe.ninja price exports, compared against
  today's live price. The current league and its start date are hardcoded in
  `lib/league-recency.ts` (`CURRENT_LEAGUE`) and need updating by hand each time a new
  challenge league launches. `npm run check-league` compares it against poe.ninja's own
  live leagues list and warns if it's gone stale (see below) - run this whenever you
  suspect a new league has launched, then update `CURRENT_LEAGUE` by hand.
- **Confidence scoring**: each suggestion also gets a confidence tier (High/Medium/Low)
  based on how reliably that item has actually gained in past leagues, not just how big
  the predicted gain is - see `lib/confidence.ts`.
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
- **Mirage simulator** (`/mirage-simulator`): a testing page that replays the model
  against the Mirage league - which is always excluded from training - so you can pick
  a day and duration and see the model's prediction next to what actually happened.
- **Current league tester** (`/current-league-tester`): look up a single item/currency
  by name and see the model's live prediction for it, without needing the full
  suggestions table.
- **Data store**: [DuckDB](https://duckdb.org) (embedded, columnar, great for analytical
  queries over large CSV history) - no external database server required.

## Setup

1. Copy `.env.local.example` to `.env.local` and fill in:
   - `POE_DATA_DIR` - folder containing `<League>/<League>.currency.csv` and
     `<League>.items.csv` exports (semicolon-delimited, columns
     `League;Date;Get;Pay;Value;Confidence` for currency and
     `League;Date;Id;Type;Name;BaseType;Variant;Links;Value;Confidence` for items).
   - `SITE_PASSWORD` - a shared password gating the whole app (see `proxy.ts` /
     `lib/site-auth.ts`). Not per-user auth, just a gate since this is shared with a
     handful of people. Required - unset, the login page rejects every attempt.
2. Ingest historical data into DuckDB:
   ```bash
   npm run db:ingest
   ```
3. Run the dev server:
   ```bash
   npm run dev
   ```

## Known limitations

- poe.ninja's economy/pricing endpoints aren't part of any officially documented public
  API and may change or break without notice, though poe.ninja does publish a small API
  reference (poe.ninja/docs/api) covering some of what's used here, including the
  leagues-list endpoint `npm run check-league` relies on.
- Flip suggestions are a simple heuristic (historical growth from a given day of the
  league over a given duration) - not financial/trade advice, and confidence varies
  with how many past leagues have data for a given item.
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
- `scripts/check-current-league.ts` - compares the hardcoded `CURRENT_LEAGUE` against
  poe.ninja's live leagues list; run via `npm run check-league`.
- `lib/db.ts` - shared DuckDB connection.
- `lib/poe-ninja.ts` - live poe.ninja price client (with caching).
- `lib/growth-ratios.ts` - core historical growth-ratio queries (recency-weighted).
- `lib/league-recency.ts` - per-league recency weighting, and the current league.
- `lib/confidence.ts` - confidence-tier scoring for a prediction.
- `lib/price-history.ts` - per-item price history across past leagues, for the chart.
- `lib/flip-suggestions.ts` - ranks live prices by projected growth.
- `lib/mirage-simulator.ts` - backs the `/mirage-simulator` testing page.
- `lib/faustus.ts` - GGG Currency Exchange client (live prices and buy/sell spreads).
- `lib/faustus-gold.ts` - gold cost per item on the Currency Exchange.
- `lib/liquidity.ts` - liquidity tiering for Currency Exchange spreads.
- `lib/site-auth.ts` / `proxy.ts` - the shared-password login gate.
- `app/api/*/route.ts` - read-only data endpoints used by the UI (deliberately Route
  Handlers, not Server Actions - see the comment in `mirage-simulation/route.ts`).
- `app/currency_exchange_flip`, `app/mirage-simulator`, `app/current-league-tester` -
  the app's secondary pages; the dashboard (flip suggestions) lives at `/`.
- `components/*.tsx` - dashboard UI (flip suggestions, category/confidence/liquidity
  filters, price history chart), the Currency Exchange Flip panel, and the Mirage
  simulator panel.
