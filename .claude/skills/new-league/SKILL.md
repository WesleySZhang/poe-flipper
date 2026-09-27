---
name: new-league
description: Use when a new Path of Exile challenge league launches or the current one ends - the checklist of what to update, regenerate, retrain and rerun in this app.
---

# New league checklist

1. **League config.** `lib/league-recency.ts`: add the new league's release date to
   `LEAGUE_RELEASE_DATES` and set `CURRENT_LEAGUE`. Update the "as of" date in its comment.
2. **Decide whether to train on the finished league** (the owner's call). Short event leagues and
   leagues with broken data have been left out before; see `lib/training-leagues.ts` and
   `scripts/discover-training-leagues.ts`. Prefer waiting for poe.ninja's export
   (`https://poe.ninja/poe1/api/data/dumps` lists them; usually a day or two after the league ends).
3. **Retrain:** GitHub -> Actions -> "Retrain model" with the league in `add_league` (optionally
   `drop_league`). It edits `lib/training-leagues.ts`, downloads history, rebuilds
   `db/history.duckdb`, exports features, trains on CPU, runs parity and the Mirage backtest, and
   opens a PR (`auto/retrain-model`). Review the report before merging:
   - every league's source should be "poe.ninja export"; "data branch" means the export wasn't out
     yet and the league is missing days;
   - any "worse than the previous model" line.
   After merging, precompute reruns itself (the model file changed); run "Deploy to production".
   The manual equivalent is in `ml/README.md` section 12.
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
