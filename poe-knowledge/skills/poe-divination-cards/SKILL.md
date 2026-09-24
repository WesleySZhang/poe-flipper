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

## Sources

- RePoE `base_items.json` (`stack_size`, `description` reward markup)
- poewiki card pages for reward and drop info
- `docs/faustus-mapping.md` (which cards are exchange-tradeable)

## Owner notes

<!-- Add cards you know are traps (drop-restricted, league-only, vendor-recipe), and real flips you have run. -->

## Gaps

- Drop sources and per-card drop rates are not modeled.
- Cards disabled or removed in a league show as "Disabled" text in RePoE; the list of those is not tracked.
