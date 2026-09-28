# New league: course of action

What to do, in order, when a challenge league ends and the next one starts. Most of it is automated;
your part is starting one workflow, reviewing three pull requests and deploying.

**T** below is the new league's launch: usually a Friday at 20:00 UTC (from GGG's leagues API).

## Timeline

| When | What happens | Automatic? | Your action |
| --- | --- | --- | --- |
| About **T−4 days** | The old league ends. poe.ninja stops updating it; the site keeps showing its last prices. | – | None |
| About **T−3 days** | poe.ninja publishes the old league's export (Mirage's was up a day after it ended). | – | [1. Retrain](#1-retrain-on-the-league-that-ended) |
| **T** | The new league launches. | – | None yet |
| **T + ~4 h** (00:05 UTC) | The league swap PR opens. | Yes | [2. Merge the swap](#2-merge-the-league-swap) |
| After the swap is merged | The new items PR opens at the next 01:20 UTC run, if the league added items or categories. | Yes | [3. New items](#3-new-items-and-categories) |
| **First week** | Daily prices collect; predictions settle. | Yes | [4. Check the first days](#4-check-the-first-days) |
| Any time after | Docs and knowledge. | – | [5. Tidy up](#5-tidy-up) |

The two gaps before launch are from the last two leagues' dates (Keepers ended 2026-03-02, Mirage
started 2026-03-06; Mirage ended 2026-07-20, Allflame started 2026-07-24). Check the dates for the
league at hand: `https://poe.ninja/poe1/api/data/dumps` lists exports, and GGG's
`https://api.pathofexile.com/leagues?type=main&realm=pc` has each league's `startAt` and `endAt`.

## 1. Retrain on the league that ended

Best done before launch, so the model is ready for day 0, when it's most accurate. After launch
works too.

1. **Decide whether to train on it.** Short event leagues and leagues with broken data have been
   left out before (see `lib/training-leagues.ts`). The training set is usually the last five or
   so leagues. Dropping the oldest when adding one is your call.
2. **Wait for poe.ninja's export.** Without it, the data would come from the app's own daily
   snapshots, which miss the days before collection started (Allflame's only began on league day 60).
   The workflow refuses the league that's still `CURRENT_LEAGUE` until the export exists.
3. **Run it:** GitHub → Actions → **Retrain model** → Run workflow, with the league in
   `add_league` (and optionally one in `drop_league`). It takes 1–3 hours.
4. **Review the PR** ("Retrain model: add ..."):
   - every league's source says "poe.ninja export";
   - no warning that a league's prices start late;
   - no "worse than the previous model" line. If there is one, look at the full validation report
     before deciding. More leagues isn't automatically better.
5. **Merge, then run Deploy to production.** The daily job reruns by itself. The ended league now
   also shows on item charts as a past league.

## 2. Merge the league swap

The PR ("New challenge league detected: ...") changes `CURRENT_LEAGUE` and adds the league's start
date in `lib/league-recency.ts`.

1. Check it's a real launch, and that the start date matches the launch day. The date comes from
   GGG's leagues API; if GGG didn't list the league yet, it's the detection day, one day late.
   League days count from this date.
2. Merge. The daily job reruns by itself and starts collecting the new league's prices.
3. Run **Deploy to production**. Until you do, the site still prices against the old league.
4. Optional: run **Check for new items** now instead of waiting for its nightly run (step 3).

If the PR doesn't appear, run **Check for a new league** by hand. If it still doesn't find the
league, poe.ninja isn't listing it yet.

## 3. New items and categories

The daily **Check for new items** job checks `CURRENT_LEAGUE`, so it sees the new league once the
swap is merged. It opens a PR when the league adds poe.ninja categories, Currency Exchange names or
divination cards. Merge it, then deploy. Its report lists what it can't do:

- **Gold costs** for new exchange items (`lib/faustus-gold.ts`).
- **Category filter placement** for new categories (`lib/category-reliability.ts`). Until then they
  sit in "Etc.", hidden by default.

RePoE (the game-data source for cards and exchange names) can lag a patch by a few days. Run the
workflow again by hand once it catches up.

Categories that moved between poe.ninja's currency and item endpoints need a human look: history
lookups by exact category can miss them (see the `poe-item-categories` skill).

## 4. Check the first days

- **Day 0–1:** Flip Predictions loads for the new league and the league day reads 0 or 1. Early
  prices are volatile and poe.ninja lists few items at first; that's expected. Items the league
  added get prices and links but no forecast until a league containing them is trained on.
- **Day 2:** the `precompute-data` branch has `history/<New league>/` files, and the item page chart shows a
  current-league line.
- **Currency Exchange Flip:** its name map fills in by itself as markets open (the daily check adds
  names).

## 5. Tidy up

- `poe-knowledge/` skills: the league list and any new mechanics (`poe-league-lifecycle`,
  `poe-economy-basics`).
- `ml/README.md` results, if you want them to reflect the retrained model.
- Optional: the Mirage simulator always replays Mirage (`lib/mirage-league.ts`). Moving it to a newer
  finished league is a separate change: the Mirage backtest and the retrain's holdouts depend on it.
- Optional: the `precompute-data` branch keeps ended leagues' daily files (about 50 MB a month). Once a league
  is in the training set they're only a fallback and can be deleted.

## If something goes wrong

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No swap PR a day after launch | poe.ninja not listing the league yet, or the job failed | Run **Check for a new league**; check its log |
| League days off by one | Start date was the detection day | Fix the date in `lib/league-recency.ts`, merge, deploy |
| Retrain refuses the league | Still `CURRENT_LEAGUE` and not exported yet | Wait for poe.ninja's export |
| Retrain job fails at the parity check | The TypeScript model doesn't match Python | Nothing ships; see the job's logs artifact |
| Site still shows the old league | Not deployed | Run **Deploy to production** |
