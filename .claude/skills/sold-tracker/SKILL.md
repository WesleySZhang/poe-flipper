---
name: sold-tracker
description: Use when adding or changing the trade searches the sold listing tracker follows, running it locally, changing what it stores, previewing the Sold Listings page with mock data, or working out why that page is empty, stale or shows odd sales.
---

# The sold listing tracker

`scripts/track-sold-listings.ts` follows trade site listings (instant buyout, listed in the last
week) matched by the links in `sold-tracker/searches.md`, and records which sell. The "Track sold
listings" workflow runs it ~5.5 h every 6 h, then force-pushes `state/`, `sold-listings/` (the
page's file: recent sales/unsold and every listing still up, which the page shows as unsold) and `ended/` (the full history, JSONL by month) to the
`sold-tracker-data` branch; `/sold-listings` reads `sold-listings/<League>.json` (`lib/sold-listings.ts`,
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

## Change what it stores

The workflows only run the script from master, so a change to `lib/sold-tracker.ts` or the script
goes live on merge - no workflow edit (check `git diff master <branch> -- .github/workflows/`).
Keep the stored shape backward compatible, since `state/` on `sold-tracker-data` carries over:

- New fields optional (`detail?`). `recordListing` rebuilds `item` on every check, so listed
  listings pick a new item field up at their next check; ended ones keep what they had.
- Dropped fields (e.g. `missingSince`) can stay in old JSON - nothing reads them.
- Don't rename or re-mean a `status` value without migrating `state/` by hand.
- `lib/trade-api.ts` types are what we read of GGG's fetch response; the response already carries
  mods with roll ranges, properties, item text etc., so reading more of it needs no new request.

## When something looks wrong

- **"publish failed" in the run log:** the push was refused or timed out. Tracking carries on and the
  next publish (30 min later, or the final step) retries; the branch keeps the previous snapshot.
- **Page says "No tracker data yet":** the `sold-tracker-data` branch or the current league's file is
  missing. Check the workflow's last run; the file is per league, so a league swap starts empty.
- **Workflow fails with `403 (blocked before reaching the API)`:** pathofexile.com refused GitHub's
  runner IP. Run the tracker from another machine (it only needs Node and the repo).
- **Warning icon on a search:** it failed (hover for the error), or got more than 200 new
  listings between runs (the newest and oldest 100 are fetched) and missed some - narrow it.
- **Page not updated today:** check the day's "Track sold listings" run. GitHub starts it hours
  late, and occasionally skips it; the next run catches up (state carries over).
- **"Tracking N" well below the trade site's count:** expected for about a week after a search
  starts. A search returns at most 100 ids, so the first run takes only the newest and oldest 100
  of the listings already up (the first run on 2026-09-28 took 205 of 546). New listings are all
  caught after that, and the untracked backlog expires within 7 days of being listed. If it's still
  far below after a week, check for "missed some" warnings or skipped runs. A one-time backfill
  (splitting the search by price or listing age so each slice is under 100) would close it at once;
  not built.
- **Short manual runs:** "How long to run" defaults to 330 minutes. A short run (e.g. 20) publishes
  only at its end and re-checks little, so the page barely moves.
- **"paused" on a search:** it now matches more than 3,000 listings, so it takes nothing new (its
  tracked listings are still checked). Narrow the link; it resumes on its own once under.
- **"Tracking limit reached":** 6,000 listings are being followed, so new ones are skipped until
  some sell or expire. Narrow or remove searches.
- **PR check fails with "Couldn't measure":** the trade site refused or failed - it fails closed.
  Re-run it; if it's a 403 from GitHub's runners, see the workflow's comments.
- **A "sale" that wasn't:** a listing counts as sold at the first check that finds it gone (the
  owner's call: pulling an item to relist it later is rare, and repricing happens in place). A
  seller pulling an item for good looks the same. One relisted under the same item id is reopened
  and marked "Relisted".
- The rules (gone = sold; 7 days = unsold; each listing checked once per 6-hour run; fetches
  paced 25 s apart) and limits are constants in `lib/sold-tracker.ts`; the rate-limit margin (70%)
  is in `lib/trade-api.ts`.
- **Page slow to load:** the page file holds every listing still up, ~1.7 KB each with item details
  - ~10 MB near the 6,000 cap. Next step if needed: load item details per row as they scroll into
  view, rather than in the page file.
- **File sizes:** GitHub rejects files over 100 MB, which would fail every publish. The archive is
  one file per day (`ended/<League>/<YYYY-MM-DD>.jsonl`) to stay far under it; the tracker splits
  any old month file (`YYYY-MM.jsonl`) into day files at start. `dropUnusedDetail` strips fields
  older versions stored (item text, flavour text) from the state as it loads.
- **How long records are kept:** page file - sold 30 days (`SOLD_PAGE_DAYS`), unsold 7
  (`UNSOLD_PAGE_DAYS`), listed always; state - ended listings 7 days (`STATE_KEEP_ENDED_DAYS`);
  archive - forever. **No backup:** each publish replaces the branch with a single commit, and each
  run restores the branch, then republishes it all, so a run that restored an incomplete copy and
  published would lose the archive for good. Copy `ended/` elsewhere if the history matters.
- **Checks falling behind** (listings not re-checked each run): the tracked count is near what one
  run's fetch budget covers (~6,750), or runs were short/skipped. Lower `MAX_TRACKED_LISTINGS` or
  narrow searches.

## The page

- The searches head the page as filter chips (none picked = All; counts are the current tab's).
- One row per item: `components/poe-item-tooltip.tsx` draws the item like the game's tooltip (see the
  `poe-item-display` skill for its colours, markup and sections); beside it, the listing's facts -
  a price timeline (earlier prices struck through, time at each; `priceSpans` in
  `lib/sold-tracker.ts`), listed / sold or expired / time up / search. Each mod line: text centred,
  tier ("T7", magic/rare only) at the left, roll range at the right on hover/tap only (laid over
  the line so the text never shifts). Rows don't open anything (the owner dropped the detail dialog
  so text can be selected). Both tabs sort by price, lowest first, by default (shared sort state).
- Unsold = listings still up ("Still listed" badge, "Last seen" date) + ones expired after 7 days.
- Item stats come from the tracker's `SoldListingItem.detail` (every mod with roll ranges and tier,
  properties with "(augmented)" markers, requirements, sockets, influences, relic/foil, item class).
  The in-game item text and flavour text aren't stored whole (the item text was half of each
  listing's size): **Copy item** rebuilds it with `itemGameText` (`lib/item-text.ts`) - GGG's format
  plus the in-game "(implicit)"/"(crafted)"/... markers PoB needs; see the `poe-item-display` skill.
  To re-check the rebuild, fetch a mix of items (rare, magic, unique, relic, fractured, crafted,
  mirrored, synthesised, influenced, corrupted, sockets, a weapon), run each through
  `toListingItem` and diff `itemGameText` against the decoded `extended.text` (drop its flavour
  and "Place into..." sections and the markers). Path of Building can parse it headless: its
  repo's `src/HeadlessWrapper.lua` + LuaJIT, run from the PoB install, with a pure-Lua stand-in for
  `lua-utf8` if its DLL doesn't load; `new("Item", text)`.
  Listings stored before a field existed get it at their next check (ended ones never do).
- **Previewing the UI with no real data:** build a fixture of real items (fetch ids with
  `TradeApiClient.fetchListings`, run them through `recordListing`, set statuses/times by hand) and
  either fulfil `/api/sold-listings` with it from Playwright (`page.route`) or point
  `SOLD_LISTINGS_FILE` at it. The local-only `preview/sold-listings-mock` branch does this with 40
  real Watcher's Eyes - never merge it or push it.
- **Mock preview not showing?** Usually one of:
  - The checkout isn't `preview/sold-listings-mock` (only that branch's `lib/sold-listings.ts`
    returns the fixture). `git checkout preview/sold-listings-mock`; the dev server picks it up.
  - The branch is behind: `git merge master` (or the feature branch) into it to see the latest UI.
  - Cache: its route caches under `"sold-listings-preview"` so real data cached under
    `"sold-listings"` on another branch can't be served in its place. Keep that key distinct.
  - Check: `curl` `/api/sold-listings` (logged in) should return league `"Allflame"`, 187 tracked.
  Make UI changes on a feature branch, then merge that into the preview branch.

Trade API facts (limits, listing fields, repricing keeps the id) are in the `poe-data-sources`
skill.
