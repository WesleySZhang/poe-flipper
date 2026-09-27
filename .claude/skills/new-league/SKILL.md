---
name: new-league
description: Use when a new Path of Exile challenge league launches or the current one ends - the checklist of what to update, regenerate, retrain and rerun in this app.
---

# New league checklist

The full, dated course of action for the owner is `docs/new-league.md`; read it first and keep it in
sync with this. In short, in order:

1. **Old league ends (about T−4 days).** Once poe.ninja exports it (`/poe1/api/data/dumps`), run the
   "Retrain model" workflow with it in `add_league` (whether to train on it is the owner's call; see
   `lib/training-leagues.ts`). It edits the list, downloads history, rebuilds `db/history.duckdb`,
   trains on CPU, checks parity and the Mirage backtest, and opens a PR (`auto/retrain-model`).
   Review: every source "poe.ninja export", no late-start warning, no "worse than the previous
   model" line. Merge, then Deploy to production. Manual equivalent: `ml/README.md` section 12.
2. **New league launches (T, ~20:00 UTC).** The league swap PR opens at 00:05 UTC: `CURRENT_LEAGUE`
   plus the start date from GGG's leagues API (the detection day if GGG doesn't list it, one day
   late). Check the date, merge (precompute reruns by itself), Deploy to production.
3. **New items and categories.** "Check for new items" checks `CURRENT_LEAGUE`, so it only sees the
   new league after the swap is merged; run it by hand then instead of waiting for 01:20 UTC. Its
   report lists the manual follow-ups: gold costs (`lib/faustus-gold.ts`) and category filter
   placement (`lib/category-reliability.ts`). RePoE can lag a patch by a few days; rerun it once
   RePoE updates. Dust values aren't part of that check: once poedb has the new league's uniques,
   run `npx tsx scripts/generate-disenchant-values.ts --write` (Dust Value page) and commit it.
4. **Categories that moved** between the currency and item endpoints need a look beyond what the check
   does (see the `poe-item-categories` skill): history lookups by exact category can miss.
5. **First days:** the league day reads 0-1, and `history/<League>/` appears on the `data` branch
   after the first daily run (see the `precompute-check` skill).
6. **Tidy up:** knowledge skills in `poe-knowledge/` (league list, new mechanics), the README, and
   optionally `ml/README.md` results. The Mirage simulator and backtest still replay Mirage
   (`lib/mirage-league.ts`).

Nothing reaches the live site until Deploy to production runs: `vercel.json` disables auto-deploy.
