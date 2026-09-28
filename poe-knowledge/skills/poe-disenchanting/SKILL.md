---
name: poe-disenchanting
description: Use when a question involves Kingsmarch disenchanting or Thaumaturgic Dust - how much dust an item gives, which unique is the best value to buy and disenchant, or the dust formula (item level, quality, corruption, influence).
---

# Disenchanting and Thaumaturgic Dust

As of: Allflame league (2026-09). Tags: `[verified]` confirmed in repo/source, `[owner]` from the
owner's play knowledge, `[unsure]` unchecked - never present these as settled.

## Facts

- Disenchanter workers in Kingsmarch (the Settlers of Kalguur town) turn equipment into
  **Thaumaturgic Dust**, in real time. Dust enhances shipments and powers the Recombinator. The
  disenchanting inventory is 12 x 10; a higher-rank Disenchanter works faster. `[owner]`
- How long an item takes is set by its item level. `[owner]`
- Non-unique items: item level, modifier tiers and other factors set the dust. `[owner]`
- Uniques: a higher unique tier, drop level and item level give more dust. `[owner]`
- poedb's formula for a unique (2026-09-27):
  `dust = value × 100 × (20 − (84 − clamp(ilvl, 65, 84))) × (1 + quality/100)`, where `value` is a
  per-unique number poedb lists. `[verified]` (poedb Kingsmarch page, Disenchant tab)
  - **Item level dominates:** the multiplier runs ×1 at ilvl 65 (and below) to ×20 at ilvl 84+, so
    the same unique can give 20x the dust. `[verified]` (from the formula)
  - poedb lists 1,511 uniques (1 struck through as removed); base values run 0.58 to 1,128.89, median ~6. The top are Original
    Sin 1,128.89, Replica Cortex 1,064.09, then Headhunter / Mageblood / Defiance of Destiny at
    891.16 - chase uniques, never cheap. `[verified]` (poedb, 2026-09-27)
- **Quality:** the in-game description says each 1% quality adds 2% dust; poedb's formula (and its
  q20 column, exactly ×1.2 of ilvl 84) uses 1% per quality. They disagree. `[unsure]`
- **Another formula is in circulation** with the same per-unique base values (all 1,193 it carries
  equal poedb's) but a different item-level curve: `5 × (50 + 2·(clamp(ilvl,46,68)−46) +
  ⌊3·(clamp(ilvl,46,68)−46)/11⌋ + 25·(clamp(ilvl,68,84)−68))`, i.e. exactly 1.25× poedb's from ilvl 68
  up (×2500 vs ×2000 at 84) and a gentler slope below 68; it also counts +2% per quality and +50%
  per influence and per corruption implicit. Which multiplier is right is open (TODO.md) - one
  in-game disenchant of a known-ilvl unique settles it. `[unsure]`
- Each corrupted implicit or influence type adds 50% dust. `[owner]` (in-game description; not in
  poedb's formula)

## In this app

- **Dust Value page** (`/dust-value`, `components/dust-value-panel.tsx`, `lib/dust-value.ts`): uniques
  ranked by dust per chaos. Values: `lib/disenchant-values.ts`, generated from poedb by
  `scripts/generate-disenchant-values.ts --write` (rerun when a league adds uniques). Formula:
  `lib/dust.ts`. `[verified]`
- Item level scales every unique by the same factor, so it changes the dust shown but never the
  ranking; the page defaults to ilvl 84. `[verified]` (from the formula)
- The page assumes every item is at 0% quality (unqualified, as most disenchant fodder actually
  is). Quality would count +2% dust per point if assumed otherwise. Each row links a trade site
  search at the page's item level or above. `[verified]` (`lib/dust.ts`, owner's call, 2026-09-28)
- Name matching (2026-09-27): every non-Foulborn unique poe.ninja lists matches a poedb name exactly
  (including accents like Mjölner). All 237 Foulborn names have their base in poedb; they're left out
  until it's known whether a mutated unique gives its base's dust. `[verified]`
- The cheapest uniques on poe.ninja are priced below 1c (0.04c Fencoil - listed for a cheaper
  currency), so the raw top of the ranking is sub-chaos items; a min price of 1c shows the rest.
  `[verified]` (2026-09-27)

## Sources

- https://poedb.tw/us/Kingsmarch#Disenchant - per-unique dust values and the formula
- poewiki "Kingsmarch" / "Disenchanter" pages for the mechanic itself

## Owner notes

<!-- Add what you know from playing. Tag each `[owner]`. -->

## Gaps

- A game-file source for the per-unique `value`: RePoE's uniques.json doesn't carry it (checked
  2026-09-27), so poedb is the only source found.
- Whether Foulborn (mutated) uniques give their base unique's dust.
- Whether Kingsmarch accepts unique maps and jewels (poedb lists values for them).
- Whether the quality bonus is 1% or 2% per point.
- poe.ninja unique prices don't carry item level, so the dust a listed unique would give is unknown
  (it could be anywhere from ×1 to ×20).
- The dust formula for non-unique items.
- Whether Thaumaturgic Dust can be traded, which would give dust itself a chaos value.
