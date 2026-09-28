---
name: sold-tracker
description: Use when adding or changing the trade searches the sold listing tracker follows, running it locally, or working out why the Sold Listings page is empty, stale or shows odd sales.
---

# The sold listing tracker

`scripts/track-sold-listings.ts` follows trade site listings (instant buyout, 100d+, listed in the
last week) matched by the links in `sold-tracker/searches.md`, and records which sell. The "Track
sold listings" workflow runs it ~5.5 h every 6 h and force-pushes `sold-listings/<League>.json` to
the `sold-tracker` branch; `/sold-listings` reads it (`lib/sold-listings.ts`, 5-min cache).

## Add a search

1. Build the search on the trade site; copy the browser address (`/trade/search/<League>/H4sI...`).
2. Add it under `## Searches` in `sold-tracker/searches.md` as `- [Label](link)`. Labels must be
   unique (they tie listings to searches); a bare link gets the item name as its label.
3. Check it decodes: `npx tsx -e 'import("./lib/trade-query").then(m => console.log(JSON.stringify(m.parseTradeSearchUrl("<link>"))))'`.
   An id not starting `H4sI` can't be decoded - copy the link again.
4. Check its size: a search's `total` (on the page, or in the run log) is how many listings it adds.
   All searches together should stay under ~1,000 listings, or hourly checks fall behind.
5. Merge to master: the workflow checks out master, so a search only goes live once it's there.

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
- **Warning icon on a search:** it failed (hover for the error), or got 100 new listings between
  runs and missed some - narrow the search.
- **A "sale" that wasn't:** a seller pulling an item for good looks the same. One that's relisted
  under the same item id is reopened and marked "Relisted".
- The rules (24 h gone = sold, 7 days = unsold, hourly checks) are constants in `lib/sold-tracker.ts`;
  the rate-limit margin (70%) is in `lib/trade-api.ts`.

Trade API facts (limits, listing fields, repricing keeps the id) are in the `poe-data-sources`
skill.
