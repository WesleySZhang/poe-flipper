# ML experiments: could a learned model beat the production predictor?

Question: is a machine-learning model more effective than the current model
(`lib/growth-ratios.ts` - recency-flat, peer-shrunk average of past leagues' growth ratios)?

**Short answer: yes, substantially - but most of the gain comes from a new *signal* the production
model ignores, not from model complexity.** Details, method, and caveats below.

## Method (why the comparison is fair)

- **Baseline = the real production code.** `scripts/export-backtest-baseline.ts` runs the production
  model for every trained league held out in turn and dumps its predictions plus what actually
  happened (`ml/cache/baseline_rows*.csv`, git-ignored). The ML models are scored on *exactly those rows*
  (identical matching rules, tolerances, minimum-league gates).
- **Leave-one-league-out.** For each holdout league H (Settlers, Mercenaries, Keepers, Phrecia 2.0,
  Mirage): H's data is never used for training, feature construction, or early stopping. Training rows
  come from the other 4 leagues, each *also* featurized only from the other leagues excluding itself
  (nested exclusion), so a row never sees its own league - exactly like predicting a brand-new league.
- **Only features production genuinely has** for a live league: other leagues' trajectories for the
  item, the item's *current live price*, the divine orb's current price, league day `t`, horizon `h`,
  category. Never the target league's own history/future (the current league has no daily history in
  production). Round 2 below adds exactly one more input the live API does provide: poe.ninja's 7-day sparkline.
- **Pipeline validated first** (`check_features.py`): it reproduces 100% of production's rows with
  identical labels, and my re-derived peer-shrunk estimate correlates 0.997 with production's
  prediction and scores the same Spearman vs reality (0.3065 vs 0.3066 on Mirage).
- Metrics: Spearman (the tool ranks flips), top-decile realized return / hit rate (what following the
  top suggestions actually paid), directional accuracy, MAE in log space.
- Hardware: XGBoost 3.2 (`device=cuda`) and PyTorch 2.11+cu128 on an RTX 5080.

## Results

### Early league (day <= 30), pooled over 5 holdouts, 2.84M scored rows

| model | Spearman | top-10% mean log-return | top-10% hit rate | direction acc | MAE (log) |
|---|---|---|---|---|---|
| **production** | 0.324 | +0.466 | 66.8% | 64.7% | 0.300 |
| linear: shrunk ratio + price-vs-history percentile (2 features) | 0.441 | +0.596 | 70.4% | 67.4% | 0.298 |
| XGBoost (GPU), production-style inputs only | 0.343-0.352 | +0.475 | 69.5% | 68.4% | 0.296 |
| **XGBoost (GPU), all features** | **0.486-0.491** | **+0.630** | **73.7-75.2%** | **71-74%** | **0.268-0.272** |
| MLP (GPU) | 0.469-0.475 | +0.627 | 73.9% | 69.4% | 0.267 |
| XGBoost + MLP ensemble | 0.493 | +0.636 | 74.3% | 71.4% | 0.266 |

Every one of the 5 holdouts improves (worst-league Spearman 0.42 vs production's 0.30).

### Late league (day 30-110) - where the app is today (Allflame ~day 57)

| model | Spearman | top-10% hit rate | direction acc |
|---|---|---|---|
| **production** | **0.068** | **48.6%** (coin flip) | 54.9% |
| linear 2-feature | 0.206 | 55.2% | 61.8% |
| XGBoost (GPU) | 0.198-0.217 | 58.2-59.8% | 62-63% |

Production is essentially noise past day 30 (its own UI warns as much). The mean-reversion signal
turns that into a real, if modest, edge in all 4 testable leagues (Phrecia only ran 21 days). Restricted
to items >= 5c: Spearman 0.05 -> 0.23, top-decile hit rate 49% -> 62%.

### Divine-denominated predictions (the UI's Chaos/Divine toggle)

Spearman 0.310 (production) -> 0.398 (linear) / 0.420 (XGBoost); top-decile hit rate 58.8% -> 64.8% / 68.9%.

## Where the gain comes from

Ablations (`ablation.py`): give XGBoost only production-style inputs (cross-league ratio statistics)
and it barely helps (0.343-0.352 vs 0.324). **Adding one signal - the item's current price relative to
what it cost on the same league-day in past leagues (`rel_level`, i.e. mean reversion) - takes it to
~0.48.** Feature importance agrees (`rel_level_pct` is #1 by gain). A two-feature linear formula
captures ~72% of the total early-league gain; XGBoost adds the rest (category/day/horizon
interactions) and, unlike the linear model, also improves calibration (MAE) and directional accuracy.
A neural net on the GPU is *not* better than gradient-boosted trees here (typical for tabular data).

Fitted on all leagues (`fit_final.py`, in-sample - validation is above):

    early: pred_logret = +0.273 + 0.973 * shrunk_base - 0.543 * rel_level_pct
    late:  pred_logret = +0.191 + 0.257 * shrunk_base - 0.324 * rel_level_pct

i.e. early in a league production's historical ratio is trusted almost fully and an item priced high
vs. its same-day history is expected to fall ~35% relative to a cheap one; late in a league
production's own signal deserves only ~0.26 weight and price-vs-history carries most of the call.

## Robustness / caveats

- **Live-price mismatch** (`robustness.py`): the level signal compares today's live poe.ninja price to
  history-export prices. Injecting independent +/-20% per-item noise into "price now" still leaves
  XGBoost at 0.466 and the formula at 0.427 Spearman (production 0.324); even 50% noise stays above
  production for the formula. `rel_level_pct` is a cross-sectional *rank*, so it is invariant to any
  uniform scale difference between the two feeds. Not testable here: item-specific systematic
  differences between the feeds - shadow-log live predictions vs. outcomes before trusting it.
- **Only 5 leagues.** Consistency across all 5 holdouts (and Mirage, the newest, is effectively a
  forward-in-time test) is encouraging, but Allflame is a 6th, different economy.
- **Grid coverage.** Scenarios are the backtest's grid (t in {0..25}, h in {2..30}; late: t 30-110,
  h 3-30). A production port should be trained on / checked at the days users actually query.
- Ranking edge is not a guarantee of profit: no spread/fees/liquidity modelled in these numbers.

## Round 2: momentum, trends, and other model families (early league, t = 0-25)

Motivation: early-league predictions matter most (currency roughly doubles-to-triples in the first weeks, and
dispersion between items is widest then), so round 2 evaluates *early* scenarios, currency separately, and
by league-day bucket. Same leave-one-league-out protocol, same production rows; headline metric is the
**per-scenario Spearman** (rank items within one league/kind/day/horizon - market-wide moves cancel).

### The momentum signal is available live

poe.ninja's API already returns a **7-day sparkline** that the app currently discards
(`receiveSparkLine` / `sparkline` / `sparkLine`: 7 points, % change vs 6-7 days ago). Coverage on live Allflame:
currency and exchange lines 100%, uniques 79-97%, skill gems 76%. Validated against the stored daily history of
Mirage: the first six points match our history (to rounding), only the last point differs (it is the live
price, not the last daily row), and ~3% of points are `null`. So momentum from `db/history.duckdb` is a faithful
backtest proxy. Causality of every new feature is unit-tested (`check_leakage.py`: erase the future, features unchanged).

### What the data say (`trend_analysis.py`)

- **Currency trends continue; items mean-revert.** Rank correlation of the 6-day change with the next return:
  currency +0.24 (t 7-10), +0.34 at 20-30 day horizons; items ~0 (+0.03..+0.08). For items the signal is *price
  vs. same-day history* (mean log-return +0.15 for cheap-vs-history items, -0.04..+0.01 for expensive ones) regardless of momentum, plus category-level momentum (+0.09..+0.15).
- **Predictability is front-loaded.** Best single-signal Spearman ~0.6 at day 0 falling to ~0.15 by day 14-25;
  cross-sectional dispersion of returns is 1.04 (currency, day 0) vs 0.35 (day 14+).
- Currency drifts down ~15% over the first 5 days, then rises 20-50% over 20-30 days.

### Results (per-scenario Spearman; production 0.328)

| model | all | day 0 | day 2-4 | day 7-10 | day 14-25 | currency, day 0 / 2-4 / 7-10 / 14-25 |
|---|---|---|---|---|---|---|
| production | 0.328 | 0.535 | 0.440 | 0.295 | 0.135 | 0.611 / 0.515 / 0.351 / 0.144 |
| formula F0 (2 features, round 1) | 0.412 | 0.661 | 0.561 | 0.355 | 0.182 | 0.709 / 0.570 / 0.327 / 0.137 |
| formula, coefficients per day-bucket x kind, + momentum | 0.433 | 0.664 | 0.567 | 0.376 | 0.226 | 0.723 / 0.580 / 0.364 / 0.205 |
| XGBoost, 21 portable features | 0.471 | 0.682 | 0.593 | 0.419 | 0.284 | 0.718 / 0.596 / 0.408 / 0.281 |
| XGBoost, all 58 features, depth 8 | 0.488 | 0.694 | 0.612 | 0.448 | 0.292 | 0.725 / 0.616 / 0.439 / 0.279 |
| 3 XGBoost seeds + GPU MLP (not portable) | 0.498 | 0.702 | 0.623 | 0.456 | 0.302 | 0.733 / 0.629 / 0.455 / 0.293 |

**For the first ~5 days the piecewise formula captures essentially all of the ML gain** (currency top-10% mean
log-return: production 1.03 -> formula 1.27 vs. XGBoost 1.27 at day 0; 0.98 -> 1.15 vs 1.15 at day 2-4). XGBoost pulls
ahead from day ~7 (+0.04 currency at 7-10, +0.075 at 14-25), where momentum matters. Top-decile hit rate overall:
production 66.8% -> formula 73.1% -> XGBoost 77.4%. Every model beats production in all five holdouts, and the 21-feature XGBoost beats the formula in
all five (worst league: production 0.219, formula 0.345, XGBoost 0.381).

Divine-denominated mode (UI toggle): production 0.330 -> XGBoost 0.443 (formula 0.398); top-decile hit rate 58.8% -> 69.4% (`divine_check.py`).

### What did not help (all tested, `explore.py`)

- **Learning-to-rank objectives** (pairwise, NDCG): worse than plain regression (0.443 / 0.453 vs 0.479 at the time).
  A rank-normalised regression target is equal (0.493, best hit rate 78.7%); a demeaned target is equal.
- **Analog forecasting** (weight each past league's own ratio by momentum/level similarity): ~0.
- **Denoising** (reference ratio averaged over +-2 days, 3-day-smoothed level): the smoothed *ratio* is a little better,
  the smoothed *level* is worse (the live price is the signal); net zero in XGBoost, negative in the formula.
- **Currency-specific handling** (up-weighting currency rows x10/x40, separate per-kind models): no gain -
  the joint model does not underserve currency.
- **Own price history** (growth since day 0, drawdown from peak, 14-day momentum; would need a daily log of the live
  league): +0.005 over the 7-day sparkline. Not worth building storage for.
- **Removing league-level macro features** (divine price etc.), hypothesising they let the model memorise leagues:
  slightly worse, so the hypothesis is refuted. Picking the top-8/12/16 features by gain also fails (0.42-0.45);
  a hand-picked 21-feature set works (0.471), see below.
- **Hybrid** (formula + residual trees): 0.472 at 250 depth-6 trees; with small trees it collapses to the formula.
- Capacity matters a little: depth 8 > depth 6 (+0.01); the GPU MLP is 0.476, only useful inside an ensemble (+0.005).

### Robustness (`robustness2.py`; test-time perturbation, models trained on clean data)

| | formula | XGBoost (21 feat.) | production |
|---|---|---|---|
| clean | 0.433 | 0.471 | 0.328 |
| +-10% noise on the live price (applied consistently to level and momentum) | 0.426 | 0.449 | |
| +-20% | 0.410 | 0.428 | |
| no sparkline for 25% of items | 0.427 | 0.453 | |
| no sparkline at all | 0.408 | 0.419 | |

Still well above production in every case, but XGBoost's lead over the formula halves with 20% noise
(+0.039 -> +0.018). The observed live-vs-history difference on the last sparkline point was ~3-6%.

### Deployment footprint of the portable model (`export_model.py`, `eval_model.mjs`)

21 features, each computable from what the app already fetches (cross-league aggregates it already computes,
one extra aggregate - mean past log price at day t, ~25 ms standalone on the 8.2M-row table -, the sparkline, the live
price). Exported to a plain JSON tree list and scored with a ~15-line JavaScript evaluator; output matches XGBoost to 1e-6.

| trees | LOLO Spearman | model file (raw / gzip) | inference, 13.7k rows (Node) | cold-start JSON parse |
|---|---|---|---|---|
| 400 (depth 8) | 0.471 | 3.8 MB / 1.2 MB | 233 ms | 7 ms |
| 200 | 0.468 | 1.9 MB / 0.6 MB | 100 ms | 4 ms |
| 100 | 0.463 | 0.9 MB / 0.3 MB | 44 ms | 2 ms |

Free-tier notes: the model is a plain committed file, so it adds nothing to Git LFS (the 72 MB DuckDB file is the only LFS object
and no database change is needed) and is negligible against Vercel's function size limit; the cost is CPU per
request, which a 20-minute in-memory cache keyed on (day, horizon) - the same TTL as the poe.ninja cache - bounds to
one evaluation per warm instance per window. To avoid Python/TypeScript feature drift, a port should generate its
training features from the TypeScript code path (extend `scripts/export-backtest-baseline.ts`), not from `features.py`.

## Production integration (shipped)

The learned predictor is live in the app. `PREDICTOR=xgb` (default) | `formula` | `baseline` (the original behaviour,
one env var away); a missing model file falls back to the formula, then baseline.

| piece | file |
|---|---|
| poe.ninja 7-day sparkline plumbed through | `lib/poe-ninja.ts` |
| extra cross-league aggregates (raw log ratio, spread, past price level, peer group), multi-league exclusion | `lib/growth-ratios.ts` |
| features - the one implementation used by the live app, the simulator and the training export | `lib/prediction-features.ts`, `lib/history-now.ts` |
| tree evaluator + formula tables + `PREDICTOR` switch | `lib/prediction-model.ts`, `lib/models/predictor.json` (4.5 MB - grew from 1.9 MB once the p10/p90 quantile heads below were added) |
| used by | `lib/flip-suggestions.ts`, `lib/mirage-simulator.ts` (the single-item spot check still shows the historical ratio: it has no live price) |
| training data export / fit / checks | `scripts/export-training-features.ts`, `ml/fit_production.py`, `scripts/check-predictor-parity.ts`, `scripts/backtest-predictor.ts` |

Refresh after ingesting a new league: `npm run ml:export-features` (~30 min), `python ml/fit_production.py all`, `npm run ml:parity`,
`npm run ml:backtest`, commit `lib/models/predictor.json`.

**Validation on the shipped code path** (Mirage replayed through `lib/mirage-simulator.ts`, model trained WITHOUT Mirage,
features built by the app's own TypeScript; per-scenario means over league days 0-75, horizons 3/7/14):

| | Spearman | top-10% hit rate | top-10% mean log-return |
|---|---|---|---|
| production | 0.185 | 61.7% | 0.313 |
| formula | 0.324 | 69.7% | 0.581 |
| XGBoost | 0.334 | 72.8% | 0.590 |

By league day the XGBoost/formula Spearman is 0.60/0.60 (day 0), 0.51/0.50 (day 3), 0.35/0.32 (day 7), 0.25/0.23 (day 14),
0.32/0.30 (day 30), 0.21/0.22 (day 50), 0.24/0.26 (day 75) vs production 0.47, 0.38, 0.28, 0.15, 0.08, -0.04, 0.02 - the
formula ties or beats XGBoost on day 0 and in the late league, XGBoost leads from day ~3 to ~30. The TypeScript runtime
reproduces Python's predictions to 1e-6 (`npm run ml:parity`). Divine mode: 0.174 -> 0.329 (holdout, all days).
These are one holdout (the newest league) on a coarse grid; the five-league study above is the broader evidence.

**Live testing found three training/serving mismatches that validation alone did not (all fixed):**
1. *League-wide price offset.* Allflame's Divine is 358c at day 57 vs 130-144c in three past leagues, so every item was
   ~2.5x "expensive" vs history; raw level features made XGBoost forecast a -7.7% median. Level features are now
   demeaned across the market and the tier feature is the price in divines.
2. *Missing momentum.* ~48% of live items have no usable sparkline, vs 0.3% of historical rows. Training rows now lose momentum at 45%.
3. *Out-of-range `n_ref`* (4 past leagues live at day 57, at most 3 in training): dropped as a feature.
Items under 1c (tick-size noise, e.g. 0.03c -> 0.05c = "+67%") were topping the list; the model is now trained on items >= 1c
and serves the production ratio for anything cheaper, mirroring the original 1c floor.

**A determinism bug in the original queries** was found on the way: the nearest-day lookup had no tie-break, so a league
with no price on the exact day but prices at day-1 and day+1 was resolved by DuckDB's parallel scan order - the same query
returned ratios up to ~17% apart on consecutive runs. It now ties to the earlier day (`lib/growth-ratios.ts`); this changes
individual production ratios slightly, in the direction of reproducibility.

**Known limits.** The live sparkline is raw while the stored history had single-day glitches corrected at ingest, so live
momentum is noisier (median 6-day volatility ~2x historical); the robustness tests above cover +-20% noise on the last
point, not this. Live predictions use 4-5 reference leagues where training rows saw at most 4. Confidence scores still
describe cross-league consistency, not the learned forecast (see "Forecast precision" below for what does). Nothing here
has run against a live league's *outcomes* yet: log a few weeks of live forecasts against what happened before treating
the absolute numbers as settled.

## Forecast precision: quantile heads (shipped)

`lib/confidence.ts`'s score answers "has this item consistently gained across past leagues" - a different question
from "how wide is the model's own uncertainty band around *this* forecast" (in backtesting, high-confidence rows had
*higher* absolute error than low, simply because reliable gainers move further - see that file's module doc). A
p10/p90 quantile pair on the chaos log-return, sharing the point model's feature set, answers the second question and
is shipped as `FlipSuggestion.forecastSpread` / `MirageSimulationRow.forecastSpread` (a ratio-space multiple, e.g. 1.8
means the model's own middle-80% range spans a factor of 1.8x) - appended to the confidence badge's hover text as a
second, clearly separate sentence, never blended into the score itself (`lib/confidence.ts`'s `describeConfidence`).

**Validated** (`test_quantile_xgb.py`, Mirage holdout): mean |point-model error| climbs monotonically across predicted-
spread deciles, 0.070 (narrowest) -> 0.592 (widest), 8.2-8.4x; Spearman(spread, |error|) = 0.50-0.52. Calibration is
decent but not exact: P(y < p10) landed at 0.156-0.168 against a target of 0.10 depending on the training set (some
tail under-coverage - a narrower-than-ideal band), P(y < p90) at 0.837-0.841 against 0.90. Chaos-denominated and
`xgb`-mode only; divine was not validated by this test. Items under the 1c floor (see above) get no spread, same as
they get no learned point forecast.

**Deployment bug found and fixed**: XGBoost's built-in `reg:quantileerror` objective (`test_quantile_xgb.py`'s
original approach) trains a booster whose serialized JSON tree dump (`base_weights` + `base_score`) does **not**
reproduce its own `predict()` output on XGBoost 3.2.0 - confirmed by matching leaf indices exactly via `pred_leaf`
(ruling out a tree-walk bug), then ruling out `eta` scaling, `base_score` handling, GPU vs CPU, `QuantileDMatrix`,
and even XGBoost's own `pred_contribs` SHAP-style bias term - none reconciled a ~1.0 log-return gap. Since the
shipped predictor is a from-scratch TypeScript tree walker (no XGBoost runtime on Vercel - see "Deployment
footprint" above), an unreproducible objective is a dead end regardless of accuracy. The shipped quantile heads
(`fit_production.py`'s `pinball_objective`) instead train with a **custom** grad/hess objective (pinball loss,
constant Hessian - standard practice for non-twice-differentiable quantile loss) via `xgb.train(obj=...)`, which
produces an ordinary single-output booster serialized the same proven way as the point/formula/divine models
(`npm run ml:parity`: 1e-6 max diff) and, empirically, calibrated as well or slightly better than the built-in
objective did.

## Reproduce

    # once
    python -m venv ml/.venv
    ml/.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
    ml/.venv/Scripts/python -m pip install -r ml/requirements.txt

    npx tsx scripts/export-backtest-baseline.ts                    # ~5 min -> ml/cache/baseline_rows.csv
    SCENARIO_SET=late npx tsx scripts/export-backtest-baseline.ts  # -> ml/cache/baseline_rows_late.csv

    cd ml
    ../ml/.venv/Scripts/python check_features.py    # pipeline validation vs production
    ../ml/.venv/Scripts/python run_experiment.py    # early-league: production vs XGBoost (GPU)
    ../ml/.venv/Scripts/python models_compare.py    # linear vs XGBoost variants vs GPU MLP
    ../ml/.venv/Scripts/python ablation.py          # feature-group ablations, price subsets, importance
    ../ml/.venv/Scripts/python run_late.py          # day 30-110
    ../ml/.venv/Scripts/python robustness.py        # divine target, live-price noise
    ../ml/.venv/Scripts/python fit_final.py         # coefficients of the simple model

    # round 2 (momentum etc.)
    ../ml/.venv/Scripts/python check_leakage.py     # momentum/own-history features never see the future
    ../ml/.venv/Scripts/python build_folds.py       # ~1 min: caches LOLO train/test sets as parquet
    ../ml/.venv/Scripts/python explore.py run       # ~15 min GPU: every model variant, predictions cached
    ../ml/.venv/Scripts/python explore.py report    # score everything (by day bucket, currency vs items)
    ../ml/.venv/Scripts/python trend_analysis.py    # momentum vs mean reversion, market drift, dispersion
    ../ml/.venv/Scripts/python robustness2.py       # live-price noise, missing sparklines
    ../ml/.venv/Scripts/python divine_check.py      # divine-denominated mode
    ROUNDS=200 ETA=0.1 ../ml/.venv/Scripts/python export_model.py && node eval_model.mjs  # size, parity, JS speed

## Files

| file | purpose |
|---|---|
| `features.py` | leakage-safe feature engineering from `db/history.duckdb` |
| `run_experiment.py` | LOLO harness + XGBoost (GPU) + shared scoring |
| `models_compare.py` | linear / XGBoost variants / GPU MLP / ensemble |
| `ablation.py` | which feature groups matter; tradeable-price subsets |
| `run_late.py` | late-league (day 30-110) evaluation |
| `robustness.py` | divine target; live-price noise sensitivity |
| `fit_final.py` | fits the simple 2-feature formula for a possible port |
| `check_features.py` | validates the pipeline against production |
| `build_folds.py` / `explore.py` | round 2: cached LOLO folds; every model variant + scoring by day bucket / kind |
| `trend_analysis.py` | descriptive: momentum vs reversion, market drift, dispersion |
| `robustness2.py` / `divine_check.py` | noise + missing-sparkline tests; divine-denominated mode |
| `check_leakage.py` | causality test for the momentum / own-history features |
| `export_model.py` / `eval_model.mjs` | round-2 prototype of the portable model export + JS evaluator with parity + timing |
| `fit_production.py` | fits + exports the shipped model (`lib/models/predictor.json`) from TypeScript-built rows; validation report |
| `test_quantile_xgb.py` | exploratory: does a quantile spread predict point-model error (yes) - superseded by `fit_production.py`'s shipped custom-objective quantile heads |
| `test_currency_leadlag.py` | exploratory: is there a learnable cross-currency lead-lag signal (X's move predicting Y's a few days later) beyond the single-item momentum/mean-reversion signal already shipped - real pairs vs a shuffled-pairs null, with out-of-sample sign replication on a held-out league; not wired into `fit_production.py` |
| `test_sparkline_cnn.py` | exploratory: does a 1D CNN over the raw 7-point sparkline path beat the hand-built momentum scalars (`mom1`/`mom3`/`mom6`/`vol6`/`accel`/`dev_sm3`) already shipped, using `scripts/export-sparkline-paths.ts`'s complete-path rows; not wired into `fit_production.py` |
