# Sold tracker searches

The trade site searches the sold listing tracker follows (`scripts/track-sold-listings.ts`). Each
list item under **Searches** is one search: `[label](link)`, or a bare link.

To add one, set up the search on the trade site, copy the address from the browser, and add it as
a list item. Any filter works - item name, base type, mods, a price range. The tracker applies its
own rules on top, whatever the link says:

- instant buyout only;
- listed in the last week (a shorter age filter in the link wins);
- the current league, whatever league the link was made in.

**Limits** (`lib/sold-tracker.ts`) - the trade site's rate limit covers about this many listings
checked hourly:

- at most **600 listings per search**;
- at most **1,000 listings** across all searches;
- at most **20 searches**.

A PR that changes this file runs the "Check sold tracker searches" check: it counts each search's
listings on the trade site today and fails if they're over the limits (`npm run sold:check` does the
same locally). A price range is the usual way to bring a search down. While running, the tracker
also pauses a search that has grown past 600, and stops taking new listings at 1,000 - both show on
the Sold Listings page.

## Searches

- [Watcher's Eye](https://www.pathofexile.com/trade/search/Allflame/H4sIAAAAAAAAClWOOw7CMBBEr4KmoXGRtO45AwWKkIkXsSLZWPYGiCzfHTkNZqo3-5FeRlKna4LNWILyIrBINK7R3SZCMRA3EyzOTscHxWM6nDaC2d8S7CVDt1APnHgY3HlSinUxlKGpGRqdp2szaDBEHqnCzALbd535yXh-sewmLJ4-5P9U-zfRE6XmC0mpIPDLAAAA)
