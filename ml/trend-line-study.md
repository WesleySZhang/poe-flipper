# Whole-trend-line forecasting (study, not shipped)

> **Status (2026-09-28):** research from 2026-09-21, carried over from an uncommitted working copy.
> Nothing here was built as described. Since then the app sidesteps the per-request cost a different
> way: the daily precompute job scores every horizon (1-30 days) once a day and publishes them to the
> `precompute-data` branch, so the "Days ahead" slider and the chart's predicted line read that file
> instead of re-running the model. The findings below still matter if that job gets too slow, for
> early-league behaviour, and for how much per-horizon model calls really add. The `scripts/_trend_*.ts`
> scratch scripts it cites were never committed.

**Question.** The app scores one `(today, N days ahead)` point per request; changing "Days ahead" re-runs everything. Would
computing the whole curve once (so a slider needs no refetch, and the chart can draw a predicted line) be better? Tested on
the out-of-sample Mirage replay (`lib/mirage-simulator.ts`, model trained without Mirage, replay days 3/7/14/21/30 and
45/60 - the live league is on day ~59 - horizons h = 2..30, i.e. the model's trained range, so a curve is capped at 30
days). Only items the model actually scores (>= 1c) with data at every horizon: 51,310 item-curves on days 3-30, 13,524 on
days 45-60. Scratch scripts: `scripts/_trend_*.ts`.

**Bottom line (nothing here is implemented - `lib/` and the app are unchanged).** A whole trend line does not need one
model call per day - **from about league day 3 onward**. There, one model pass at h=14 plus a learned per-kind shape
reproduces the exact 29-call curve's accuracy (chaos: same Spearman and level error vs realised outcomes on Mirage days
3-60, incl. items the curve extrapolates to) at **less compute than one horizon costs today** (674 vs 815 ms, with a
tree-major forest walk that is bit-identical to the shipped one), and one computation then serves every slider position.
**It does NOT hold in the first ~3 days of a league** (see "Early league" below): the one-pass curve over-predicts short
horizons by 10-50% there. Other measured exceptions and open questions: divine-denominated items at 19-30 days lose ~0.024
Spearman with one pass (a second pass recovers it); `confidence` / `upFraction` / the eligible-item set vary with the
horizon and would be frozen at h=14 unless computed separately; validated on one league (Mirage) only.

**Where one request's compute goes today** (`_trend_profile.ts`, warm poe.ninja/Faustus caches, ~9.8k scored rows, h=7):

| step | time |
|---|---|
| growth-ratio SQL (currency + item, concurrent) | ~245 ms |
| `buildFeatureMatrix` | ~22 ms |
| chaos + divine forests (200 trees x depth 8 each) | ~154 ms |
| p10 + p90 quantile forests | ~197 ms (largest single piece) |
| everything else (candidate build, rationale text, sort) | ~85 ms |
| **`getFlipSuggestions` total** | **~0.7 s** (0.7-1.0 s across runs) |

Two "obvious" optimizations turned out to be worth ~nothing: only **2%** of scored rows are sub-1c items (scored, then
replaced by the baseline anyway), and feature building is 22 ms, so caching the horizon-independent feature columns saves
nothing. Any speed-up has to come from the SQL, the forests, or running fewer of them.

**Exact per-horizon curve (29 independent model calls): rejected.**
- Cost: ~1 s per extra horizon in the live path = **27 s** for 29 (sequential). The existing batched ratio SQL
  (`getCurrencyGrowthRatiosBatch` / `getItemGrowthRatiosBatch`, one pass for many scenarios, verified identical to the
  single-scenario functions at h=14: 10,605/10,605 rows match) cuts the SQL from 13.3 s to 7.4 s, but scoring 29 horizons
  is another 9.6 s: **>= 17 s**, still far too slow.
- Accuracy: **not better** than cheap approximations (table below).
- Shape: **jagged**. Every horizon is an independent model call, so 99.8% of items change direction >= 4 times across the
  28 steps (mean 12); the typical wobble around a smooth curve is +-4% (days 3-30) / +-2% (days 45-60). That wobble is
  not signal - smoothing the exact curve scored the same or marginally better - and it would read as noise on a chart.

**Anchor horizons + interpolation** (model run only at a few horizons, log-ratio linearly interpolated through (0, 0)).
Spearman vs the realised outcome, by horizon bin (currency | items):

| approach | days 3-30, h 2-7 | h 8-18 | h 19-30 | days 45-60, h 2-7 | h 8-18 | h 19-30 |
|---|---|---|---|---|---|---|
| exact, 29 calls | .277 \| .308 | .380 \| .350 | .440 \| .336 | .240 \| .152 | .390 \| .163 | .375 \| .091 |
| smoothed exact (quadratic fit) | .298 \| .315 | .392 \| .359 | .449 \| .341 | .242 \| .155 | .400 \| .165 | .384 \| .095 |
| 6 anchors (2/5/9/14/21/30) | .282 \| .309 | .384 \| .352 | .446 \| .336 | .245 \| .154 | .398 \| .162 | .379 \| .089 |
| 4 anchors (3/7/14/30) | .279 \| .310 | .385 \| .352 | .448 \| .334 | .251 \| .152 | .394 \| .162 | .390 \| .099 |
| 2 anchors (7/30) | .287 \| .307 | .390 \| .354 | .445 \| .332 | .249 \| .153 | .411 \| .165 | .388 \| .096 |
| 1 anchor (h=14), scaled linearly | .291 \| .310 | .382 \| .349 | .434 \| .329 | .236 \| .146 | .383 \| .160 | .397 \| .109 |
| 1 anchor (h=30), scaled linearly | .296 \| .301 | .386 \| .344 | .442 \| .327 | .217 \| .131 | .390 \| .158 | .384 \| .093 |

Anchor curves (2/4/6 anchors) match the exact curve's Spearman to within ~0.02 everywhere - usually a hair *above* it,
never meaningfully below - and their mean |log error| vs the outcome is within ~0.01 of the exact curve's. With 4 anchors
the interpolated line differs from the exact one by 1.3-7.5% (currency) / 0.8-5.6% (items), growing with horizon; that is
the same order as the exact curve's own wobble around a smooth fit (currency 3.3-5.8%, items 1.9-4.3%), so most of what
anchors "lose" is noise the exact curve carries. Differences of ~0.005 Spearman are within noise (single league,
correlated items within a day) - the honest reading is "no measurable loss", not "smoothing is better". The one clear
loser is scaling **linearly** from one anchor: the predicted move grows like roughly **h^0.6**, not h (mean
|predicted log-return| 0.060 / 0.144 / 0.222 / 0.329 at h = 2 / 7 / 14 / 30 on days 3-30), so a straight line from h=14
is 0.256 (currency) off the exact curve by h 19-30 vs 0.06-0.08 for the anchor methods, and its error vs the outcome is
the only one that visibly worsens there (0.657 vs 0.626).

**Cost of anchor curves** (`_trend_anchor_cost.ts`, batched SQL + scoring incl. quantile heads, live day 59):
4 anchors [3,7,14,30] = 0.56 s SQL + 1.27 s scoring = **1.8 s**; 6 anchors = 1.58 s + 2.0 s = **3.6 s** - i.e. ~2.5x / ~5x
one horizon today, before any optimization.

## Getting the whole curve for the price of one horizon

Anchors are still several passes (4 anchors = 2.5x today's compute). The budget is "no more compute than one horizon
today", so the next question was how few model passes a whole curve really needs - and whether a *curve-level* method
(fit the shape, not each point) can replace the extra passes.

**A curve is nearly one-dimensional.** Uncentered PCA of the model's own exact 29-point curves (`_trend_shapes.ts`, all
7 replay days): the top component alone carries **94.9% (currency) / 94.0% (items)** of the curve's squared magnitude, two
carry 97.1% / 96.8%, three 97.9% / 97.7%. What is left after component 1 is mostly the per-horizon wobble above, not
item-specific shape. So one model output (the level) plus a population shape describes almost the whole curve.

**One pass at h=14 + a learned shape matches the exact 29-call curve.** The shape is per-horizon OLS weights through the
origin, `y(h) = w_kind(h) * y(14)`, fitted on *other* days' exact curves (a power law `y(14) * (h/14)^alpha` scores
identically on Spearman and only slightly worse on curve fit; fitted alpha from the h=14 anchor is 0.36 currency / 0.40
items, stable across folds at 0.32-0.42 - but from the h=30 anchor it is 0.56 / 0.68, i.e. the curve flattens with h and is
not one power law, which is why per-horizon weights are used rather than a single exponent). Spearman vs the realised
outcome by horizon bin, currency | items:

| approach (model passes) | fit days 3-30, test days 45/60: h 2-7 | h 8-18 | h 19-30 | leave-one-day-out, all 7 days: h 2-7 | h 8-18 | h 19-30 |
|---|---|---|---|---|---|---|
| exact, one call per horizon (29) | .240 \| .152 | .390 \| .163 | .375 \| .091 | .267 \| .263 | .383 \| .297 | .421 \| .266 |
| **one pass at h=14 + learned shape (1)** | .236 \| .146 | .383 \| .160 | .397 \| .109 | .276 \| .263 | .383 \| .295 | .423 \| .266 |
| one pass at h=7 + learned shape (1) | .249 \| .153 | .404 \| .164 | .363 \| .108 | .276 \| .263 | .380 \| .289 | .386 \| .256 |
| one pass at h=30 + learned shape (1) | .217 \| .131 | .390 \| .158 | .384 \| .093 | .273 \| .252 | .388 \| .291 | .426 \| .260 |
| two passes 7/30 + learned shape (2) | .249 \| .153 | .411 \| .165 | .389 \| .097 | .276 \| .261 | .397 \| .299 | .430 \| .266 |
| two passes 3/14 + learned shape (2) | .261 \| .150 | .392 \| .161 | .397 \| .109 | .271 \| .267 | .383 \| .298 | .423 \| .266 |
| four passes 3/7/14/30, linear interpolation (4) | .251 \| .152 | .394 \| .162 | .390 \| .099 | .271 \| .265 | .388 \| .298 | .431 \| .267 |

The mean |log error| vs the realised outcome is within ~0.007 of the exact curve for every method above, except the h=7
anchor at long horizons (+0.011, LODO currency). h=14 is the best single anchor: h=7 loses at long horizons (0.386 vs 0.423,
LODO currency), h=30 loses at short ones (0.252 vs 0.263 items). Extra passes buy little and inconsistently: the one gain
that shows up in both splits is 7/30's mid-horizon currency Spearman (+0.028 early-to-late, +0.014 LODO vs one pass at
h=14); 3/14's short-horizon currency gain (+0.025 early-to-late) reverses under LODO (-0.005), and no extra-pass gain
appears for items beyond +0.005. Caveats: one league, ranks within a day are correlated, ~0.005 differences are noise.

**Consequence worth knowing.** A single anchor scaled by a per-kind constant per horizon cannot reorder items *within a
kind* as the horizon changes, and it scores the same as the exact curve - i.e. across days 3-60 of Mirage, the per-horizon
model calls the app makes on every "Days ahead" change mostly rescale the same ranking rather than find a better one; at
most there is a small mid-horizon currency gain from a second pass (cross-kind order can also still change, since currency
and item weights differ). What the slider genuinely changes is the *magnitude*: the mean |predicted move| grows roughly
h^0.6 over h = 2..30 on average (0.060 / 0.144 / 0.222 / 0.329 at h = 2 / 7 / 14 / 30), flattening as h grows.

**Forecast-spread curve.** The p10/p90 spread also follows the shape: rebuilt from its value at h=14 with a learned shape
(leave-one-day-out) the mean |error| is 0.100 (currency) / 0.079 (items) log units against a mean spread of 1.085 / 0.780,
i.e. ~10% of the spread (the displayed multiple is off by about +-10%) - so the quantile heads need to run only once.

**Cheaper passes, same output.** Profiling showed the forests dominate the compute that is not SQL. Re-ordering the
existing tree walk **tree-major** (one tree's nodes stay in cache while every row walks it; same per-row summation order)
gives **bit-identical output** (max |diff| = 0 on all four forests, and 0 after clipping vs the shipped
`scoreFeatureMatrix`) at ~1.7x the speed: chaos+divine 170 -> ~103 ms, p10+p90 217 -> ~119 ms for ~9.8k rows. Row-blocking
(256) and a column-major feature layout were no faster than plain tree-major. (Also ruled out: skipping the 2% sub-1c rows,
caching horizon-independent feature columns - see the profile above.)

**One-pass prototype vs today, end to end** (`_trend_pipeline.ts`, live inputs, ~9.3k rows, median of 5; the ratio SQL is
identical on both sides - it was noisier this run, 430 ms vs 245 ms earlier - so compare the rest):

| | ratio SQL | features | forests | expand to all 29 horizons (chaos + divine) | total |
|---|---|---|---|---|---|
| today: one horizon | 427 ms | 24 ms | 365 ms | - | **815 ms** |
| one pass at h=14 -> whole curve | 431 ms | 23 ms | 208 ms | 11 ms | **674 ms** |

So the whole curve costs *less* than one horizon does today, and because the anchor is fixed, the result depends only on
(league day, live prices, ratios) - one computation serves every slider position and every user within the 20-minute
cache window, where today each distinct "Days ahead" value recomputes SQL + model.

**Divine-denominated curve (the UI's Chaos/Divine toggle)** (`_trend_shapes2.ts`, divine forest output, same protocol).
One pass at h=14 with its own learned divine shape is as good as the exact divine curve for currency (Spearman .235 / .382
/ .392 vs exact .209 / .387 / .370 early-to-late; .281 / .375 / .411 vs .245 / .377 / .410 LODO) and for items at short and
mid horizons, with **one measurable loss: divine items at h 19-30**, -0.024 Spearman in both splits (.090 vs .114
early-to-late; .242 vs .266 LODO). A second pass (7/30) recovers it (.128 / .273) - divine curves carry more item-specific
shape than chaos ones, plausibly because the chaos-debasement path enters them.

**Fitting the shape to realised outcomes instead of the model's own curve: no.** Same Spearman by construction (a shared
per-horizon scale cannot change ranks) and a *worse* mean |log error| vs the outcome (currency LODO .384 vs .373 at h 2-7,
.525 vs .517 at h 8-18, .644 vs .636 at h 19-30) - and it would leak, since the outcomes come from the same league. Keep the
shape fitted to the model's own curve.

**The historical fields that ride along with a prediction drift with the horizon** (`_trend_confidence_drift.ts`, live day
59, batched ratio rows at h = 3/7/14/21/30 vs h=14). This is separate from the model curve above (which is nearly rank-1):
the raw per-horizon historical statistics are noisy.

| vs the h=14 rows | `confidence` mean \|diff\| | `confidence` Spearman | `upFraction` mean \|diff\| | `leagueCount` differs | historical log-ratio Spearman |
|---|---|---|---|---|---|
| currency, h=3 / 7 / 21 / 30 | 13.1 / 13.3 / 12.1 / 14.9 pts | .57 / .56 / .58 / .55 | .215 / .194 / .157 / .208 | 1.2 / 1.2 / 2.4 / 1.8 % | .36 / .54 / .61 / .49 |
| items, h=3 / 7 / 21 / 30 | 13.4 / 11.5 / 10.9 / 13.7 pts | .44 / .58 / .65 / .52 | .214 / .170 / .155 / .203 | 12.7 / 6.8 / 7.7 / 13.8 % | .37 / .59 / .67 / .54 |

The set of rows also changes with the horizon (items need enough past-league history reaching day+h): of 10,605 item rows
at h=14, **1,680 have no row at h=30** (106 exist only at h=30), and at h=3 there are 1,371 rows that h=14 lacks (53 the
other way). A one-anchor curve carries the h=14 values (and row set) for every slider position. Whether the per-horizon
differences are signal or window noise was not separately tested; the exact model curve being ~rank-1 while its inputs
vary this much suggests mostly noise, but that is an inference. If they do need to vary, they come from SQL alone (no
model pass), so extra anchors for them cost SQL time only (4 batched scenarios ~0.56 s vs ~0.2 s for one).

**Selection-bias check: items the curve extrapolates to** (`_trend_extrap.ts`, days 7/21/45/60, leave-one-day-out weights,
scored against realised Mirage prices, which exist whether or not history rows do). Every accuracy number above uses items
with an exact prediction at every horizon; a one-anchor curve also shows items with history at h=14 but not at, say, h=30.
Spearman | mean |log error| | error of predicting "no change" (context), by horizon bin 2-7 / 10-18 / 22-30:

| items | 2-7 | 10-18 | 22-30 |
|---|---|---|---|
| one pass, has an exact prediction at h | .209 \| .245 \| .246 | .243 \| .384 \| .401 | .212 \| .460 \| .483 |
| same items, exact per-horizon call | .209 \| .246 \| .246 | .244 \| .385 \| .401 | .206 \| .466 \| .483 |
| one pass, **no exact prediction at h** (extrapolated) | .320 \| .333 \| .344 | .252 \| .475 \| .485 | .285 \| .565 \| .590 |
| avg items per (day, horizon): covered / extrapolated | 10,076 / 52 | 10,041 / 206 | 9,274 / 681 |

The extrapolated items rank as well as the covered ones (Spearman .25-.32) and beat "no change" by a small margin (e.g.
0.565 vs 0.590), so showing them does not look harmful - but the samples are a few hundred items over 4 days, and Mirage
had **no** extrapolated currency rows, so that case is untested (live: only 1-2 currency rows differ across horizons).

**The top of the list** (`_trend_topk.ts`, chaos, leave-one-day-out, days 3-60). Spearman is dominated by the middle of
~10k items, but a trader acts on the top. Top 10% of each kind by predicted growth, exact per-horizon calls vs one pass at
h=14 + shape. Cell = share of picks that really rose | mean realised log-return of the picks (horizon bins 2-7 / 8-18 /
19-30); last row = how many of the exact list's top-10% members the one-pass list also contains:

| | 2-7 | 8-18 | 19-30 |
|---|---|---|---|
| currency, exact | .695 \| .692 | .816 \| 1.073 | .899 \| 1.417 |
| currency, one pass | .693 \| .681 | .795 \| 1.034 | .901 \| 1.390 |
| currency, top-list overlap | 58% | 78% | 62% |
| items, exact | .650 \| .291 | .744 \| .480 | .749 \| .568 |
| items, one pass | .643 \| .293 | .743 \| .482 | .759 \| .569 |
| items, top-list overlap | 66% | 83% | 71% |

The two methods disagree on 17-42% of the top-10% members (a rank shuffle among near-ties), yet the picks perform the
same against reality: items identical to 3 decimals; currency 1-4% lower in mean return (-0.011 / -0.039 / -0.027) and
-0.002 to -0.021 in hit rate. Currency's top 10% is only ~14 items per day, so that gap is within sampling noise but
consistently the same sign - treat it as "small possible loss", not zero.

## Early league (days 0-5): where the one-pass curve breaks

The tables above pool replay days 3-60. A reviewer's objection - prices can soar in the first days of a league and flatten
afterwards, so a curve stretched from a 14-day anchor should fail early - was tested by replaying Mirage days 0, 1, 2, 4,
5, 10 as well (`_trend_dump.ts`, `_trend_early.ts`; per replay day, leave-one-day-out, model trained without Mirage).
**The objection is right for days 0-2; it does not hold from day ~3.**

What really happens early (mean realised log-return of all items): on replay day 0, currency is **-0.23 at h=2**, -0.13 at
h=4, ~0 at h=7, +0.25 at h=14 (items -0.15 / -0.09 / 0 / +0.16) - prices dip first, then climb; day 1 is similar for items
(-0.13 at h=2). From day 3 the h=2 mean is positive and the path is a smooth climb. The average early shape is also more
front-loaded than later ones: fitted `w(h)` (share of the h=14 move applied at h) is 0.45 at h=4 and 0.67 at h=7 in days 0-5
vs 0.26-0.34 and 0.56-0.60 in days 7-14. A single scale factor on the 14-day move cannot reproduce a dip.

One pass at h=14 (pooled shape) vs exact per-horizon calls, mean |log error| vs realised [signed bias, pred - realised],
horizon bins 2-4 / 5-8 (chaos and divine views are both shown; *items* unless noted):

| replay day | chaos, exact | chaos, one pass | divine, exact | divine, one pass |
|---|---|---|---|---|
| 0, h 2-4 | .28 [+.03] | .33 [+.13] | .42 [-.09] | **.49 [+.34]** |
| 0, h 5-8 | .31 [-.04] | .34 [+.02] | .38 [+.06] | **.50 [+.33]** |
| 1, h 2-4 | .32 [+.02] | .36 [+.10] | .44 [+.28] | **.52 [+.43]** |
| 1, h 5-8 | .35 [-.03] | .37 [+.01] | .43 [+.23] | **.50 [+.35]** |
| 2, h 2-4 | .32 [-.02] | .33 [+.04] | .44 [+.27] | .49 [+.36] |
| 3, h 2-4 | .30 [-.02] | .31 [+.01] | .32 [+.07] | .32 [+.07] |
| 5, h 2-4 | .28 [-.02] | .28 [.00] | .28 [-.03] | .28 [-.05] |
| currency, day 0, h 2-4 | .45 [-.13] | .46 [+.13] | .61 [-.17] | **.69 [+.51]** |

- **Level accuracy is what fails**: on days 0-1 the one-pass curve over-predicts short horizons - by ~10-13% in chaos and
  **34-51% in divine** on day 0 - and its long-horizon under-prediction is larger too (chaos items day 0, h 15-30 bias -.27
  vs -.18). By day 3 the gap is <= 0.01 in every column. Divine is affected more (it also carries the chaos-debasement
  path); it is still visibly worse on day 2 (+.05 at h 2-4, +.07 at h 5-8).
- **Ranking is not what fails**: Spearman of the one-pass curve is equal or *better* on days 0-5 (e.g. chaos currency day 0,
  h 2-4: .54 vs .46), and the top-10% picks show no consistent loss (currency top 10% is only ~10 items - noisy).
- **A same-stage shape does not fix it**: refitting the shape on days 0-5 only (leave-one-day-out) gave the same Spearman
  and a mean |log error| within 0.01 of the pooled shape - the average shape is not the problem; the missing information is
  the horizon-specific model output at short h.
- **A second short-horizon pass does**: passes at h=4 and h=14 with a same-stage shape restore the exact curve's level
  accuracy at short horizons (chaos items day 0: .28 / .32 / .35 / .45 vs exact .28 / .31 / .34 / .42; divine items day 0:
  .38 / .40 / .46 / .52 vs exact .42 / .38 / .45 / .49), at roughly one more pass of compute; the long-horizon
  under-prediction on day 0 is **not** repaired (chaos items h 15-30 bias -.26 vs -.27 one pass, -.18 exact).
- **Sample caveats**: day 0 has only ~3.6k complete-case curves (~100 currency), one league only; the day-0/1 dip may be
  partly league-specific. The model itself is trained on many leagues and sees the league day `t` as a feature, which is
  how the exact per-horizon calls handle the early days at all.

**Consequence for any implementation:** use the one-pass curve from about league day 3 (chaos is fine from day 2; divine
from day 3); for league days 0-2 keep today's exact per-horizon path (or add the second, short-horizon pass). That is ~3 days
of a league that lasts 60-100+, so the special case is cheap - and the current league (day ~59) is nowhere near it.

**Status / still open** (this section is kept current as tests finish):
- Not tried: retraining a curve-native model (multi-output XGBoost on the cached `ml/cache/tsrows` rows, ~30 min feature
  re-export + fit). The results above suggest little ranking headroom from per-horizon information (chaos), so it is
  unlikely to be worth it before the cheap route is exhausted; the divine-item long-horizon gap is the one place it
  might.

