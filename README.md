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
  challenge league launches.
- **Category filters**: both tables can be filtered by category - an item's BaseType, or
  "Currency" for every currency row - built from whatever categories are actually
  present in the current results.
- **Mirage simulator**: a testing page (`/mirage-simulator`) that replays the model
  against the Mirage league - which is always excluded from training - so you can pick
  a day and duration and see the model's prediction next to what actually happened.
- **Data store**: [DuckDB](https://duckdb.org) (embedded, columnar, great for analytical
  queries over large CSV history) - no external database server required.

## Setup

1. Copy `.env.local.example` to `.env.local` and fill in `POE_DATA_DIR` - folder
   containing `<League>/<League>.currency.csv` and `<League>.items.csv` exports
   (semicolon-delimited, columns `League;Date;Get;Pay;Value;Confidence` for currency and
   `League;Date;Id;Type;Name;BaseType;Variant;Links;Value;Confidence` for items).
2. Ingest historical data into DuckDB:
   ```bash
   npm run db:ingest
   ```
3. Run the dev server:
   ```bash
   npm run dev
   ```

## Known limitations

- poe.ninja has no official public API. The endpoints used here were found by
  inspecting the site's own network traffic and may change or break without notice.
- Flip suggestions are a simple heuristic (historical growth from a given day of the
  league over a given duration) - not financial/trade advice, and confidence varies
  with how many past leagues have data for a given item.
- The current league is hardcoded (see above) rather than auto-detected, since there's
  no clean unauthenticated endpoint for "what league is active right now".

## Project structure

- `scripts/ingest-history.ts` - bulk-loads historical CSVs into `db/history.duckdb`.
- `scripts/backtest-mirage.ts` - CLI backtest of the model against the Mirage holdout.
- `lib/db.ts` - shared DuckDB connection.
- `lib/poe-ninja.ts` - live poe.ninja price client (with caching).
- `lib/growth-ratios.ts` - core historical growth-ratio queries (recency-weighted).
- `lib/league-recency.ts` - per-league recency weighting, and the current league.
- `lib/flip-suggestions.ts` - ranks live prices by projected growth.
- `lib/mirage-simulator.ts` - backs the `/mirage-simulator` testing page.
- `app/api/*/route.ts` - read-only data endpoints used by the UI (deliberately Route
  Handlers, not Server Actions - see the comment in `mirage-simulation/route.ts`).
- `components/*.tsx` - dashboard UI (flip suggestions, category filter) and the Mirage
  simulator panel.
