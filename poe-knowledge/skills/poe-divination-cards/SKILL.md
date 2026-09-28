---
name: poe-divination-cards
description: Use for divination card questions - stack sizes, what a turn-in rewards, which cards are safely priceable, how card flips are computed, or why a card is missing from the flips table.
---

# Divination cards

As of: Allflame league (2026-09). Tags: `[verified]` confirmed in repo/source, `[owner]` from the
owner's play knowledge, `[unsure]` unchecked - never present these as settled.

## Facts

- Turning in a full stack of one card gives a reward; the stack size is fixed per card (e.g. The
  Nurse needs 8, The Apothecary 5). `[verified]`
- Rewards are either deterministic (a specific unique, a fixed currency amount, another card) or
  random (random base type, random unique of a class, gems with random level/quality, corrupted
  outcomes). Only deterministic ones can be priced from a single number. `[verified]`
- Example flip: The Nurse at 10c x 8 = 80c cost, rewards The Doctor worth 100c, so 20c profit. `[verified]`
- The card's own in-game sub-text is not a separate item: The Apothecary rewards a Mageblood, and
  the Mageblood's own market price already includes its roll. `[verified]`
- Cards are bought like currency (Currency Exchange for many), so stack cost = card price x stack size. `[verified]`
- ~471 real cards; ~261 have a single-tag reward, of which about 108 unique + 67 currency + 5 card
  rewards match a real priced name. Roughly 130 cards have a Currency Exchange market. `[verified]`
- Confidence for a flip is the weaker of the two legs' liquidity: buying the card and selling the
  reward. Not the growth-based confidence score used elsewhere. `[verified]`

## In this app

- Card definitions: `lib/divination-cards.ts` (generated from RePoE by `scripts/generate-divination-cards.ts`).
- Scoping rule: include a card only if its reward text is one `<tag>{name}` segment AND that name
  matches a live price. This drops random/multi-tag cards and placeholder text like "Axe" without a
  hand-kept list. `lib/divination-flips.ts` does the live matching.
- Prices stay live for flips; poe.ninja files cards under `DivinationCard`, and history stores
  them as category "item" (see `poe-item-categories`).
- Table and detail page: `components/divination-flips-panel.tsx`, `components/item-detail-panel.tsx`.
- Divine mode buys the cards on their own Divine market, not a chaos price converted; the reward stays at its chaos price, converted (the owner's call). Few cards have a
  Divine market in a given hour - 11 of 76 priceable cards on 2026-09-27, mostly expensive ones
  (The Doctor, The Soul, History, House of Mirrors) - so Divine mode shows a short list.
  `[verified]` (`lib/divination-flips.ts`)
- Buy costs come from the card's last closed exchange hour: a buy order (Cost) = the bottom of the
  range × stack size, an instant buy = the top. poe.ninja's card price is only used for a card with
  no exchange market. Don't mix the two sources: poe.ninja's price is its own estimate at a
  different time, and on 2026-09-27 it sat above the exchange hour's top for 13 of 33 cards
  (Divine Beauty 203.7c vs 200-202c; The Doctor 577c vs 401c), which made the instant buy read
  cheaper than the buy order. Many cards trade at a single price in an hour, so instant often
  equals Cost. `[verified]` (`lib/divination-flips.ts`)
- Liquidity per leg: GGG's hourly traded volume on its market, or poe.ninja's exchange volume
  (`CurrencyPrice.volumeChaos`, same chaos scale) when GGG had no market that hour - most cards
  don't trade on GGG's exchange in a given hour. `[verified]` (`lib/divination-flips.ts`)
- Nothing says a full stack can be bought at the Min/Max price: the exchange API has no stock per
  price. The one quantity check is the hour's highest listed card stock vs the stack size - on
  2026-09-27, 8 of 34 exchange-traded cards never had a full stack listed (The Soul 0-5 for a stack
  of 9, Outfoxed 0, Mawr Blaidd 7-12 for 16), some rated Medium. Instant buy hides those
  (`fullStackListed` in `lib/exchange-route.ts`). `[verified]`

## Sources

- RePoE `base_items.json` (`stack_size`, `description` reward markup)
- poewiki card pages for reward and drop info
- `docs/faustus-mapping.md` (which cards are exchange-tradeable)

## Owner notes

<!-- Add cards you know are traps (drop-restricted, league-only, vendor-recipe), and real flips you have run. -->

## Gaps

- Drop sources and per-card drop rates are not modeled.
- Cards disabled or removed in a league show as "Disabled" text in RePoE; the list of those is not tracked.
