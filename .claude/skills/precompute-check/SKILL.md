---
name: precompute-check
description: Use to check or trigger the daily precompute job - whether the data branch is fresh, prices.json/predictions.json/history exist and look right, or a rerun is needed after a deploy or data bug.
---

# Check the precompute job

The workflow (`.github/workflows/precompute-predictions.yml`) runs at 00:10 UTC, on manual
dispatch, and on pushes to prediction-algorithm files. It force-pushes an orphan `data` branch with
`predictions.json`, `prices.json`, `history/`, and `vercel.json`.

1. **Freshness.** `git fetch origin data`, then:
   - `git log origin/data -1 --format=%cd` - last publish time.
   - `git ls-tree -r --name-only origin/data` - expect `predictions.json`, `prices.json`,
     `vercel.json`, and `history/<League>/*.csv` (there must be no `history/history/`).
   - `git show origin/data:prices.json | head -c 200` - check `league` and `fetchedAt` (< 36h old,
     or the app ignores it).
2. **Recent runs.** `gh run list --workflow precompute-predictions.yml -L 5`; `gh run view <id> --log-failed`.
3. **Predictions.** `predictions.json` items may carry an `e` array marking filled horizons (1 =
   interpolated, 2 = held); the job logs "Filled N horizon gaps across M items". Every item with any
   prediction should have all 30 horizons. See `lib/horizon-fill.ts`.
4. **History rows.** `git show origin/data:history/<League>/<League>.items.<YYYY-MM>.csv | cut -d';' -f2 | sort | uniq -c`
   - one block per day; today's date present after the run.
5. **Trigger a run.** `gh workflow run precompute-predictions.yml` (or GitHub -> Actions -> Run workflow).
   Needed after: first deploy of new snapshot code, a fix to the scripts, or a missed daily run.
   Pushing to master alone won't trigger it unless a watched algorithm file changed.
6. **App picks it up** within ~30 min (`prices.json` cache) / ~2 min (history and predictions). If the
   page still looks stale after that, suspect raw.githubusercontent.com's CDN cache (up to ~5 min).

Report what you verified and what you could only infer.
