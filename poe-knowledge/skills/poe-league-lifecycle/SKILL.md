---
name: poe-league-lifecycle
description: Use when reasoning about how PoE prices change over a league, which leagues this app's data covers, league day numbering, or what to update when a new league launches.
---

# League lifecycle

As of: Allflame league (2026-09). Tags: `[verified]` confirmed in repo/source, `[owner]` from the
owner's play knowledge, `[unsure]` unchecked - never present these as settled.

## Facts

- A challenge league launches on a set date and runs for months; the app counts "league day" from
  launch, with a new day starting at 00:00 UTC. `[verified]` (`lib/league-day.ts`)
- Leagues in this app's data, newest first: Allflame (current, 2026-07-24), Mirage (2026-03-06),
  Phrecia 2.0 (2026-01-29), Keepers (2025-10-31), Mercenaries (2025-06-13), Settlers (2024-07-26). `[verified]`
- The model trains on the finished leagues Mirage, Keepers, Mercenaries, Settlers, Phrecia 2.0
  (as of 2026-09; the list lives in `lib/training-leagues.ts`). Plain "Phrecia" is excluded as too
  noisy. `[verified]`
- Leagues launch at 20:00 UTC on a Friday (Allflame: 2026-07-24T20:00Z, from GGG's leagues API). `[verified]`
- The old league ends about 4 days before the next launches: Keepers' poe.ninja data ends
  2026-03-02 and Mirage starts 2026-03-06; Mirage ends 2026-07-20 and Allflame starts 2026-07-24.
  poe.ninja published Mirage's export a day after it ended. `[verified]` (two leagues only)
- Price growth is measured as the ratio of price at day N+d vs day N, matched across past leagues at
  the same league day, then adjusted with the item's live momentum. `[verified]`
- Weighting older vs newer leagues equally beat a recency decay in backtests, so all leagues count
  the same. `[verified]`
- A forecast needs >= 3 past leagues with a price near BOTH today and the target day (+-3 days). A
  league that is too short, or has a hole in an item's data, can drop that item below 3 for a
  stretch of horizons. Example: The Last One Standing had no 19-28 day forecast because Keepers
  had no price for it on days 78-93. `[verified]` (`lib/growth-ratios.ts`)
- The daily job now fills those horizons with lower-confidence estimates (interpolated between
  real horizons, held flat past the last one); see `lib/horizon-fill.ts`. A brand-new item with
  no past-league history at all still gets no forecast. `[verified]`
- The typical shape of a league (launch spike, mid-league plateau, end-of-league drop) is the reason
  same-day matching across leagues works at all. `[unsure]` (general PoE knowledge, not checked against the data)

## In this app

- Dates and current league: `lib/league-recency.ts` (edited by hand each league).
- League day math: `lib/league-day.ts`; predictions: `lib/flip-suggestions.ts`, `lib/growth-ratios.ts`.
- Training set: `lib/training-leagues.ts`; model: `ml/`, `lib/models/predictor.json`.
- **New league course of action:** `docs/new-league.md` (dated timeline) and the `new-league` skill.

## Sources

- poewiki league list; poe.ninja league selector
- `ml/README.md` for backtest results and method

## Owner notes

<!-- Add how each league's mechanic changed the economy (e.g. what crashed, what spiked, when). -->

## Gaps

- No per-league notes on which mechanics drove price behavior.
- Mid-league patches and balance changes that broke the "same day across leagues" assumption are not tracked.
