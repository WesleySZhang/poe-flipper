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
  - **Trade site** - live asking prices for individual listings; not used by this app. `[verified]`
- The Currency Exchange charges gold per trade; cost differs per item, so a spread only pays if it
  beats the gold cost. `[verified]` (`lib/faustus-gold.ts`)
- Exchange ratios are integers, so a barely-traded cheap item can show a huge "spread" from one
  unlucky trade. Volume is the check on whether a spread is real. `[verified]`
- An item can trade against Chaos and against Divine on separate markets, and the two don't
  always agree. For about 100 items (2026-09-26: Stacked Deck, Valdo's Puzzle Box, Maven's
  Invitation, Harvest seeds, ...) the Divine market traded more value than the Chaos one, and its
  quote sat ~10% above the chaos price converted at the hour's Divine rate. The app shows the
  direct Divine quote in Divine mode only where that market is the bigger one: Divine quotes for
  cheap items are coarse (1 div : 5-10 units) and ~30% of Divine pairs don't trade in a given hour.
  `[verified]` (`directDivineQuote` in `lib/faustus.ts`)
- Liquidity tiers used here, by chaos volume in the last closed hour: high >= 10,000, medium >=
  1,000, low below that. `[verified]` (`lib/liquidity.ts`)
- Unique items are not exchange-tradeable, so they only have poe.ninja prices and a seller count,
  no volume. `[verified]`
- A price with few sellers is easy to move; a low seller count means the price may be one person's
  ask. `[verified]` (`lib/flip-suggestions.ts` thin-market guard)

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
