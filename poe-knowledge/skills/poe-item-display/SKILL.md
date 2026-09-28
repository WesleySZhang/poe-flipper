---
name: poe-item-display
description: Use when showing a Path of Exile item the way the game does (a tooltip or item card) or reading an item's data - rarity and mod colours, section order, the [ref|text] markup, roll ranges, the Ctrl+C item text, relics/foils.
---

# Displaying PoE items

As of: Allflame league (2026-09). Tags: `[verified]` confirmed in repo/source, `[owner]` from the owner's play
knowledge, `[unsure]` unchecked - never present these as settled.

## Facts

- **Tooltip layout**, top to bottom: header (name, then base type on a second line for uniques and
  rares), properties ("Limited to: 1", "Quality: +20%"), requirements, sockets, "Item Level: N",
  implicit mods (enchants first), explicit mods (fractured, then explicit, then crafted), status
  lines (Corrupted, Mirrored, ...), flavour text, the price note ("~b/o 100 divine"). Sections are
  split by thin rules; text is centred. `[verified]` (matches the trade site, 2026-09-28)
- **Colours** (the game's own):
  - Rarity names: Normal `#c8c8c8`, Magic `#8888ff`, Rare `#ffff77`, Unique `#af6025`,
    Gem `#1ba29b`, Currency `#aa9e82`, Divination Card `#0ebaff`.
  - Property label grey `#7f7f7f`, value white.
  - Mods blue `#8888ff`; enchant and crafted `#b4b4ff`; fractured `#a29162`.
  - Corrupted red `#d20000`; unique flavour text in the unique colour, italic.
  `[unsure]` - from memory of the game/community renderers, checked against a trade site screenshot
  by eye only.
- **On a light page** the game's dark box looks out of place. This app draws it in black and white
  there (white background, grey labels and rules) with the same layout, and keeps the game's
  colours for dark mode. Name and mod text use the page's own foreground colour (`#0a0a0a` here) -
  softer greys for mods read as washed out next to the rest of the page. `[owner]` (2026-09-28)
- **The font** is Fontin SmallCaps (small caps, full-height digits). A serif fallback with
  `font-variant: small-caps` gets old-style digits on Windows (Palatino, Georgia) that look tiny;
  Cinzel (Google Fonts) is a close free stand-in. `[verified]` (2026-09-28)
- **Text markup:** property names and mod text can contain `[Ref|Shown text]` or `[Text]` (e.g. a
  property named "[Intangibility|Intangibility]"). Show only the text after `|`, or the bracketed
  text. `[verified]`
- **Roll ranges:** the trade API gives each mod's `mods[].magnitudes[{min, max}]` - the range of
  each number in the mod, in order. A fixed value has min = max; negative ranges exist
  ("Non-Channelling Skills have -6 to Total Mana Cost": -10 to -5). Show ranges like the game's
  Alt view: after the mod, e.g. "60% increased ... (40–60)". `[verified]`
- **The item text** (what Ctrl+C copies in game) comes base64 in the trade API's `extended.text`,
  with `\r\n` line endings. It pastes into Path of Building and the trade site's search. Some
  facts are only in it, e.g. a foil's name: "Foil Unique (Celestial Emerald)". `[verified]`
- **Relics and foils:** relic uniques have `isRelic` and a foil (`frameType` 10, "SupporterFoil";
  `foilVariation` is a number). Seen foil names: Celestial Emerald, Ruby, Sunset. They can change a
  unique's price. `[verified]` (2026-09-28)
- One item = one id: the same unique with different rolls is a different item, never merged.
  `[verified]`

## In this app

- `components/poe-item-tooltip.tsx` draws an item this way (Sold Listings); `app/layout.tsx` loads
  Cinzel as `--font-poe`; the light/dark palettes are CSS variables on `.poe-tooltip` in
  `app/globals.css`.
- `lib/sold-tracker.ts` (`toListingDetail`, `stripGameMarkup`) turns a trade API item into the stored
  detail: mods with ranges, properties, requirements, sockets, tags (influences, relic, foil). The
  item text is read for the foil name but not stored.

## Sources

- The official trade site's item tooltips (pathofexile.com/trade)
- GGG developer docs, Item type: https://www.pathofexile.com/developer/docs/reference
- poewiki.net for item mechanics

## Owner notes

<!-- Add what you know from playing. Tag each `[owner]`. -->

## Gaps

- Colours for other mod types (crucible, scourge, veiled, eldritch) and influence/header art are
  approximations.
- Gems (level/quality/experience), maps, flasks and cluster jewels have extra properties not
  checked against a real tooltip.
