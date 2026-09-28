---
name: sold-tracker
description: Use when adding or changing the trade searches the sold listing tracker follows, running it locally, or working out why the Sold Listings page is empty, stale or shows odd sales.
---

# The sold listing tracker

`scripts/track-sold-listings.ts` follows trade site listings (instant buyout, listed in the last
week) matched by the links in `sold-tracker/searches.md`, and records which sell. The "Track sold
listings" workflow runs it ~5.5 h every 6 h, then force-pushes `state/`, `sold-listings/` (the
page's file: recent sales/unsold) and `ended/` (the full history, JSONL by month) to the
`sold-tracker` branch; `/sold-listings` reads `sold-listings/<League>.json` (`lib/sold-listings.ts`,
5-min cache). Publishing (`scripts/publish-sold-tracker.sh`, a full snapshot force-pushed as one
commit) happens every 30 min during a run and once at its end, so the page lags by up to ~35 min.

## Add a search

1. Build the search on the trade site; copy the browser address (`/trade/search/<League>/H4sI...`).
2. Add it under `## Searches` in `sold-tracker/searches.md` as `- [Label](link)`. Labels must be
   unique (they tie listings to searches); a bare link gets the item name as its label.
3. Check it decodes: `npx tsx -e 'import("./lib/trade-query").then(m => console.log(JSON.stringify(m.parseTradeSearchUrl("<link>"))))'`.
   An id not starting `H4sI` can't be decoded - copy the link again.
4. Check the limits: `npm run sold:check` counts every search's listings on the trade site today.
   Limits (`lib/sold-tracker.ts`): 3,000 per search, 6,000 in total, 20 searches. Over? Add a price
   range or more filters to the link. Near a limit (80%+) passes with a warning - a busier league
   will likely push it over, and the tracker then pauses it.
5. Open a PR: the "Check sold tracker searches" check runs the same count and fails over the
   limits. The tracker workflow checks out master, so a search only goes live once merged.

## Run it locally

```
npm run sold:track -- --minutes 10            # state in .sold-tracker/, resumed next run
SOLD_LISTINGS_FILE=.sold-tracker/sold-listings/Allflame.json npm run dev   # page reads the local file
```

Only one `next dev` can run per project; stop the other one first. For UI work without a real run,
fulfil `/api/sold-listings` with a fixture file from Playwright (`page.route`) instead.

## When something looks wrong

- **"publish failed" in the run log:** the push was refused or timed out. Tracking carries on and the
  next publish (30 min later, or the final step) retries; the branch keeps the previous snapshot.
- **Page says "No tracker data yet":** the `sold-tracker` branch or the current league's file is
  missing. Check the workflow's last run; the file is per league, so a league swap starts empty.
- **Workflow fails with `403 (blocked before reaching the API)`:** pathofexile.com refused GitHub's
  runner IP. Run the tracker from another machine (it only needs Node and the repo).
- **Warning icon on a search:** it failed (hover for the error), or got more than 200 new
  listings between runs (the newest and oldest 100 are fetched) and missed some - narrow it.
- **Page not updated today:** check the day's "Track sold listings" run. GitHub starts it hours
  late, and occasionally skips it; the next run catches up (state carries over).
- **"paused" on a search:** it now matches more than 3,000 listings, so it takes nothing new (its
  tracked listings are still checked). Narrow the link; it resumes on its own once under.
- **"Tracking limit reached":** 6,000 listings are being followed, so new ones are skipped until
  some sell or expire. Narrow or remove searches.
- **PR check fails with "Couldn't measure":** the trade site refused or failed - it fails closed.
  Re-run it; if it's a 403 from GitHub's runners, see the workflow's comments.
- **A "sale" that wasn't:** a seller pulling an item for good looks the same. One that's relisted
  under the same item id is reopened and marked "Relisted".
- The rules (gone 12 h+ = sold; 7 days = unsold; each listing checked once per 6-hour run; fetches
  paced 25 s apart) and limits are constants in `lib/sold-tracker.ts`; the rate-limit margin (70%)
  is in `lib/trade-api.ts`.
- **Checks falling behind** (listings not re-checked each run): the tracked count is near what one
  run's fetch budget covers (~6,750), or runs were short/skipped. Lower `MAX_TRACKED_LISTINGS` or
  narrow searches.

Trade API facts (limits, listing fields, repricing keeps the id) are in the `poe-data-sources`
skill.
