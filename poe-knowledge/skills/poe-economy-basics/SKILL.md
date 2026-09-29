---
name: poe-economy-basics
description: Use when reasoning about Path of Exile prices - what a "price" means (stash scrape vs Currency Exchange vs trade site), spreads, liquidity, thin markets, or why a flip may not be real.
---

# PoE economy basics

As of: Allflame league (2026-09). Tags: `[verified]` confirmed in repo/source, `[owner]` from the
owner's play knowledge, `[unsure]` unchecked - never present these as settled.

## Facts

- Chaos Orb is the base unit of account; every price in this app is chaos-denominated, with Divine
  Orb as the high-value unit converted at that day's Divine rate. `[verified]`
- Three different things get called "the price":
  - **poe.ninja** - an estimate from scraped stash listings (a lag of a few minutes to hours). `[verified]`
  - **GGG Currency Exchange ("Faustus")** - actual completed trades; the API gives a per-hour
    buy/sell range and volume for the last closed hour, so it is roughly 2 hours stale. `[verified]`
  - **Trade site** - live asking prices for individual listings (the sold listing tracker follows
    them to see what actually sells). `[verified]`
- The Currency Exchange charges gold per trade; cost differs per item, so a spread only pays if it
  beats the gold cost. `[verified]` (`lib/faustus-gold.ts`)
- Exchange ratios are integers, so a barely-traded cheap item can show a huge "spread" from one
  unlucky trade. Volume is the check on whether a spread is real. `[verified]`
- An item can trade against Chaos and against Divine on separate markets, and the two don't
  always agree, so a flip can buy on one and sell on the other. For about 100 items (2026-09-26:
  Stacked Deck, Valdo's Puzzle Box, Maven's Invitation, Harvest seeds, ...) the Divine market
  traded more value than the Chaos one and quoted ~10% above the chaos price converted at the
  hour's Divine rate. `[verified]` (`getExchangeQuotes` in `lib/faustus.ts`, `lib/exchange-route.ts`)
- Divine markets are noisy in their own ways: quotes for cheap items are coarse (1 div : 5-10
  units), ~30% of Divine pairs don't trade in a given hour, and a single big trade can sit far off
  the real price (2026-09-27: Delirium Scarab of Mania's whole Divine market was 22 scarabs for
  10 div, ~184c each, vs 3-6c on Chaos). Chaos-equivalent volume doesn't catch that - one 10 div
  trade is 4,000c+ - so the app drops a market more than 2x from the item's other one, keeping
  whichever traded more units. `[verified]`
- Liquidity tiers used here, by chaos volume in the last closed hour: high >= 10,000, medium >=
  1,000, low below that. `[verified]` (`lib/liquidity.ts`)
- Unique items are not exchange-tradeable, so they only have poe.ninja prices and a seller count,
  no volume. `[verified]`
- A price with few sellers is easy to move; a low seller count means the price may be one person's
  ask. `[verified]` (`lib/flip-suggestions.ts` thin-market guard)
- **A steady listing count isn't turnover.** A trade search limited to "listed in the last week"
  keeps a flat count because new listings arrive about as fast as old ones age past the window -
  whether or not anything sells. Late Allflame (day ~66, 2026-09-28/29): 100d+ Watcher's Eyes held
  at ~545 listings with ~7 new an hour, yet none of ~220 followed for 17 hours sold or was pulled.
  High-end uniques late in a league can sit for days; measure sales by following listing ids, not
  by the count. `[verified]` (2026-09-29; one search, one league)

## In this app

- Flip Predictions (page name; code/routes still say "flip-suggestions"): predicted growth from poe.ninja history + a learned model (`lib/flip-suggestions.ts`).
- Currency Exchange Flip: buy/sell spread from Faustus, ranked with liquidity tiers
  (`components/currency-exchange-flip-panel.tsx`).
- Divination Card Flips: card stack cost vs reward value (see `poe-divination-cards`).
- Missing live price: skip the item, never fabricate a number. `[verified]`

## Sources

- GGG Currency Exchange API: `https://web.poecdn.com/api/currency-exchange`
- poe.ninja: https://poe.ninja (economy pages per category)
- Code: `lib/liquidity.ts`, `lib/faustus.ts`, `lib/faustus-gold.ts`

## Owner notes

<!-- Add what you know: how you judge a real flip, what feels manipulated, typical fees, etc. -->

## Gaps

- Trade-site price manipulation / price-fixing patterns are not documented here yet.
- How gold costs scale with item value is only known from the app's static table.
