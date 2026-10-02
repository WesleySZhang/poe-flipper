---
name: precompute-check
description: Use to check or trigger the daily precompute job - whether the precompute-data branch is fresh, prices.json/predictions.json/history exist and look right, or a rerun is needed after a deploy or data bug.
---

# Check the precompute job

The workflow (`.github/workflows/precompute-predictions.yml`) runs at 00:10 UTC, on manual
dispatch, and on pushes to prediction-algorithm files, `db/history.duckdb` or `lib/league-recency.ts`
(a merged league swap). It force-pushes an orphan `precompute-data` branch with `predictions.json`,
`prices.json`, `history/`, and `vercel.json`.

The scripts only produce the current league's current month, so the publish step first copies the
branch's existing `history/` (`git archive`) and overlays today's files. Before that fix (2026-09-26)
each 1st of the month dropped earlier months and a league swap dropped the old league's folder;
collection only began 2026-09-21, so Allflame has nothing before that.

1. **Freshness.** `git fetch origin precompute-data`, then:
   - `git log origin/precompute-data -1 --format=%cd` - last publish time.
   - `git ls-tree -r --name-only origin/precompute-data` - expect `predictions.json`, `prices.json`,
     `vercel.json`, and `history/<League>/*.csv` with **one pair per month since collection began**
     (plus ended leagues' folders). A missing earlier month means the carry-forward failed; the
     run log lists "Publishing history files". There must be no `history/history/`.
   - `git show origin/precompute-data:prices.json | head -c 200` - check `league` and `fetchedAt` (< 36h old,
     or the app ignores it).
2. **Recent runs.** `gh run list --workflow precompute-predictions.yml -L 5`; `gh run view <id> --log-failed`.
3. **Predictions.** `predictions.json` items may carry an `e` array marking filled horizons (1 =
   interpolated, 2 = held); the job logs "Filled N horizon gaps across M items". Every item with any
   prediction should have all 30 horizons. See `lib/horizon-fill.ts`.
4. **History rows.** `git show origin/precompute-data:history/<League>/<League>.items.<YYYY-MM>.csv | cut -d';' -f2,10 | sort | uniq -c`
   - one block per day; today's date present after the run. `High` = the job's own reading, `Medium` =
     rebuilt from poe.ninja's sparkline for a day the job missed (`lib/spark-backfill.ts`).
   - A missed run is repaired by the next one if it's within 6 days: look for `::notice::` lines
     ("was missing - rebuilt ...") in the run log. Older holes show as `::warning::` and can't be
     recovered; the league's poe.ninja export fills them once it ends.
5. **Trigger a run.** `gh workflow run precompute-predictions.yml` (or GitHub -> Actions -> Run workflow).
   Needed after: first deploy of new snapshot code, a fix to the scripts, or a missed daily run.
   Pushing to master alone won't trigger it unless a watched algorithm file changed.
6. **Stale-day symptoms.** The app accepts a file up to 2 league days old (shifted to today,
   `alignPrecomputedToDay`). Older than that, or from the wrong league, and every page degrades: the
   predicted line has only today + target (hover shows 2 values), `/api/flip-suggestion-curve`
   returns `[]`, `/api/flip-suggestions/precomputed` returns `null`, and tables/charts only update on
   slider release. Compare `currentDay` in the published file with `currentLeagueDay()`.
   Scheduled runs start hours after the 00:10 UTC cron; that alone is expected, not a failure.
7. **App picks it up** within ~30 min (`prices.json` cache) / ~2 min (history and predictions). If the
   page still looks stale after that, suspect raw.githubusercontent.com's CDN cache (up to ~5 min), and
   Vercel's CDN copy of `/api/flip-suggestions/precomputed` (`s-maxage=120`,
   `stale-while-revalidate=600`: up to ~12 min). `curl -sI` that endpoint (with the login cookie) and
   read `x-vercel-cache` (HIT/MISS/STALE).

Report what you verified and what you could only infer.
