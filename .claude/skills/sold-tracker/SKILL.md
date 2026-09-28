---
name: sold-tracker
description: Use when adding or changing the trade searches the sold listing tracker follows, running it locally, or working out why the Sold Listings page is empty, stale or shows odd sales.
---

# The sold listing tracker

`scripts/track-sold-listings.ts` follows trade site listings (instant buyout, listed in the last
week) matched by the links in `sold-tracker/searches.md`, and records which sell. The "Track sold
listings" workflow runs it once a day for ~45 min, then force-pushes `sold-listings/<League>.json`
to the `sold-tracker` branch; `/sold-listings` reads it (`lib/sold-listings.ts`, 5-min cache). The
page changes only when a run publishes, at its end.

## Add a search

1. Build the search on the trade site; copy the browser address (`/trade/search/<League>/H4sI...`).
2. Add it under `## Searches` in `sold-tracker/searches.md` as `- [Label](link)`. Labels must be
   unique (they tie listings to searches); a bare link gets the item name as its label.
3. Check it decodes: `npx tsx -e 'import("./lib/trade-query").then(m => console.log(JSON.stringify(m.parseTradeSearchUrl("<link>"))))'`.
   An id not starting `H4sI` can't be decoded - copy the link again.
4. Check the limits: `npm run sold:check` counts every search's listings on the trade site today.
   Limits (`lib/sold-tracker.ts`): 600 per search, 1,000 in total, 20 searches. Over? Add a price
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

- **Page says "No tracker data yet":** the `sold-tracker` branch or the current league's file is
  missing. Check the workflow's last run; the file is per league, so a league swap starts empty.
- **Workflow fails with `403 (blocked before reaching the API)`:** pathofexile.com refused GitHub's
  runner IP. Run the tracker from another machine (it only needs Node and the repo).
- **Warning icon on a search:** it failed (hover for the error), or got more than 200 new
  listings between runs (the newest and oldest 100 are fetched) and missed some - narrow it.
- **Page not updated today:** check the day's "Track sold listings" run. GitHub starts it hours
  late, and occasionally skips it; the next run catches up (state carries over).
- **"paused" on a search:** it now matches more than 600 listings, so it takes nothing new (its
  tracked listings are still checked). Narrow the link; it resumes on its own once under.
- **"Tracking limit reached":** 1,000 listings are being followed, so new ones are skipped until
  some sell or expire. Narrow or remove searches.
- **PR check fails with "Couldn't measure":** the trade site refused or failed - it fails closed.
  Re-run it; if it's a 403 from GitHub's runners, see the workflow's comments.
- **A "sale" that wasn't:** a seller pulling an item for good looks the same. One that's relisted
  under the same item id is reopened and marked "Relisted".
- The rules (gone 12 h+, i.e. on two daily runs = sold; 7 days = unsold) and limits are constants in
  `lib/sold-tracker.ts`; the rate-limit margin (70%) is in `lib/trade-api.ts`.

Trade API facts (limits, listing fields, repricing keeps the id) are in the `poe-data-sources`
skill.
