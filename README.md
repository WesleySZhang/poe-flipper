# PoE Trade Assistant

An unofficial Path of Exile companion that shows your account's stash net worth and
suggests items to flip, based on historical league economy data.

> This product isn't affiliated with or endorsed by Grinding Gear Games in any way.

## How it works

- **Net worth**: uses your account name + `POESESSID` cookie to read your stash tabs via
  the legacy `pathofexile.com/character-window` endpoint, then prices everything using
  live [poe.ninja](https://poe.ninja) data. This is an unofficial/undocumented API and a
  grey area under GGG's Terms of Use - use your own account only. Your `POESESSID` is
  kept only in an encrypted, httpOnly session cookie; it is never written to disk.
- **Flip suggestions**: ranks items/currency by how much they historically grew from
  league start to league end (averaged across past leagues), using a local DuckDB
  database built from historical poe.ninja price exports, compared against today's live
  price.
- **Data store**: [DuckDB](https://duckdb.org) (embedded, columnar, great for analytical
  queries over large CSV history) - no external database server required.

## Setup

1. Copy `.env.local.example` to `.env.local` and fill in:
   - `POE_DATA_DIR` - folder containing `<League>/<League>.currency.csv` and
     `<League>.items.csv` exports (semicolon-delimited, columns
     `League;Date;Get;Pay;Value;Confidence` for currency and
     `League;Date;Id;Type;Name;BaseType;Variant;Links;Value;Confidence` for items).
   - `SESSION_SECRET` - a random 32+ byte secret used to encrypt the session cookie.
     Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Ingest historical data into DuckDB:
   ```bash
   npm run db:ingest
   ```
3. Run the dev server:
   ```bash
   npm run dev
   ```
4. On the page, enter your PoE account name, `POESESSID`, and league to connect.

## Known limitations

- poe.ninja has no official public API. The endpoints used here were found by
  inspecting the site's own network traffic and may change or break without notice.
- Flip suggestions are a simple heuristic (historical start-of-league to end-of-league
  growth) - not financial/trade advice, and confidence varies with how many past
  leagues have data for a given item.
- Net worth pricing matches stash items by display name (and gem/unique variant where
  available); items that don't exist in the current live poe.ninja overview are valued
  at 0.

## Project structure

- `scripts/ingest-history.ts` - bulk-loads historical CSVs into `db/history.duckdb`.
- `lib/db.ts` - shared DuckDB connection.
- `lib/poe-ninja.ts` - live poe.ninja price client (with caching).
- `lib/poe-legacy-client.ts` - legacy stash API client (POESESSID-based).
- `lib/networth.ts`, `lib/flip-suggestions.ts` - core pricing/ranking logic.
- `lib/session.ts` - encrypted session cookie handling.
- `app/actions/*.ts` - Server Actions used by the UI.
- `components/*.tsx` - dashboard UI (single page: login, net worth, flip suggestions).
