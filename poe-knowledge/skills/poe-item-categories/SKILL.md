---
name: poe-item-categories
description: Use when an item's category, name, or variant matters - poe.ninja category types, currency vs item buckets, item name+variant keys, or a lookup that finds nothing because a category migrated.
---

# Item categories

As of: Allflame league (2026-09). Tags: `[verified]` confirmed in repo/source, `[owner]` from the
owner's play knowledge, `[unsure]` unchecked - never present these as settled.

## Facts

- poe.ninja splits prices into "currency-style" types (stackables): Currency, Fragment,
  DivinationCard, Scarab, Prophecy, Essence, Fossil, Oil, DeliriumOrb, Omen, Resonator, Runegraft,
  Artifact, Seed, DjinnCoin, HelmetEnchant, Watchstone, Tattoo, AllflameEmber. `[verified]`
- "Item-style" types: Unique* (Weapon, Armour, Accessory, Flask, Jewel, Map, Relic, Idol,
  Tincture), SkillGem, ImbuedGem, ClusterJewel, Map, BlightedMap, BlightRavagedMap, ValdoMap,
  Incubator, Vial, Invitation, Memory, ShrineBelt, Wombgift, KalguuranRune, Beast, Coffin,
  IncursionTemple, BaseType. `[verified]`
- **Migration trap:** poe.ninja moved several types (divination cards, scarabs, essences, fossils,
  oils, omens, and others) onto the currency endpoint. History was ingested when they were "item",
  so live price says category "currency" while history says "item". Any exact-category lookup can
  miss. `[verified]`
- Items are identified by name + variant (a gem level/quality, a unique's roll variant). The app
  keys them as `name::variant`. `[verified]`
- Some uniques (e.g. "Vaal Aspect" base-type jewels) are miscategorized by poe.ninja and need
  correcting. `[verified]` (`lib/category-reliability.ts`)
- Only stackable items can be on the Currency Exchange; uniques never are. `[verified]`
- One name+variant can have several poe.ninja lines (a base type has one per item level or
  influence). Live price takes the first line; past-league history and the current-league history
  line average a day's lines. They can disagree (Dragonscale Doublet: 1.8c live vs ~1.4c averaged). `[verified]`

## In this app

- Type lists and price maps: `lib/poe-ninja.ts` (`CURRENCY_OVERVIEW_TYPES`, `ITEM_OVERVIEW_TYPES`).
- Keys and URLs: `itemPriceKey`, item detail URLs use `_` for spaces (`/item/currency/The_Nurse`).
- History fallback: `lib/price-history.ts` falls back from currency to item history for migrated types.
- Display names: `humanizeCategoryName` (e.g. `DivinationCard` -> "Divination Card").

## Sources

- poe.ninja per-category economy pages and their API type names
- `docs/faustus-mapping.md` for exchange-tradeable names and GGG ids

## Owner notes

<!-- Add naming pitfalls: items with same names across categories, renamed items, league-only items. -->

## Gaps

- Which future league mechanics will add new poe.ninja types is unknown; check for new types each league.
- A full list of items whose names collide across categories has not been built.
