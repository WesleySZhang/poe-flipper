# Sold tracker searches

The trade site searches the sold listing tracker follows (`scripts/track-sold-listings.ts`). Each
list item under **Searches** is one search: `[label](link)`, or a bare link.

To add one, set up the search on the trade site, copy the address from the browser, and add it as
a list item. Any filter works - item name, base type, mods. The tracker applies its own rules on
top, whatever the link says:

- instant buyout only;
- at least 100 divines (a higher divine minimum in the link wins);
- listed in the last week (a shorter age filter in the link wins);
- the current league, whatever league the link was made in.

Keep each search narrow. Every listing a search finds is checked about once an hour, and the trade
site's rate limit covers about 1,000 listings across all searches; past that, checks slow down. A
search that gets more than 100 new listings between runs misses some; the Sold Listings page flags
it.

## Searches

- [Watcher's Eye](https://www.pathofexile.com/trade/search/Allflame/H4sIAAAAAAAAClWOOw7CMBBEr4KmoXGRtO45AwWKkIkXsSLZWPYGiCzfHTkNZqo3-5FeRlKna4LNWILyIrBINK7R3SZCMRA3EyzOTscHxWM6nDaC2d8S7CVDt1APnHgY3HlSinUxlKGpGRqdp2szaDBEHqnCzALbd535yXh-sewmLJ4-5P9U-zfRE6XmC0mpIPDLAAAA)
