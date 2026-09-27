---
name: new-league
description: Use when a new Path of Exile challenge league launches or the current one ends - the checklist of what to update, regenerate, retrain and rerun in this app.
---

# New league checklist

1. **League config.** `lib/league-recency.ts`: add the new league's release date to
   `LEAGUE_RELEASE_DATES` and set `CURRENT_LEAGUE`. Update the "as of" date in its comment.
2. **Finished league into history.** Get poe.ninja's history CSVs for the league that just ended,
   add it to `PRODUCTION_LEAGUES` in `scripts/ingest-history.ts`, and re-run the ingest to rebuild
   `db/history.duckdb` (it is Git LFS-tracked). Check the new league's data quality first - see
   `scripts/discover-training-leagues.ts` and the exclusion notes in the ingest script.
3. **Retrain the model** on the new league set (see `ml/README.md`; export features with the
   `scripts/export-*.ts` scripts, fit with the Python in `ml/`, update `lib/models/predictor.json`).
   Run `scripts/backtest-predictor.ts` to confirm it did not regress. This is manual today - see
   `TODO.md` item 6.
4. **New items and categories.** Run the "Check for new items" workflow (or
   `npx tsx scripts/check-new-items.ts`) instead of waiting for its daily run. It adds new poe.ninja
   categories, Currency Exchange names and divination cards, and its report lists the manual follow-ups:
   gold costs (`lib/faustus-gold.ts`) and category filter placement (`lib/category-reliability.ts`).
   RePoE can lag a patch by a few days; rerun it once RePoE updates.
5. **Categories that moved** between the currency and item endpoints need a look beyond what the check
   does (see the `poe-item-categories` skill): history lookups by exact category can miss.
6. **Update knowledge skills** in `poe-knowledge/` (league list, new mechanics) and the README.
7. **Rerun the workflow** (see the `precompute-check` skill) and confirm the data branch and app
   pick up the new league. The current league has no daily history until the daily job has run for
   a few days.
