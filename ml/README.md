# Price prediction methodology

How PoE Flipper predicts which items will gain value: how the problem is framed, what data and
features go in, how the model is trained, how it's validated, and how it runs in the app. This
folder holds the offline Python used to train and study the model; nothing here runs in production.

Contents:

1. [The problem](#1-the-problem)
2. [Data](#2-data)
3. [The baseline: historical growth](#3-the-baseline-historical-growth)
4. [Features](#4-features)
5. [Models](#5-models)
6. [Training](#6-training)
7. [Validation](#7-validation)
8. [Serving in the app](#8-serving-in-the-app)
9. [Results](#9-results)
10. [What was tried and rejected](#10-what-was-tried-and-rejected)
11. [Limits](#11-limits)
12. [Reproducing and files](#12-reproducing-and-files)

---

## 1. The problem

Every challenge league starts a fresh economy, and prices follow broadly similar paths from league
to league. The question the app answers is:

> Standing on league day **t**, with today's price for an item, how much will its price change
> over the next **h** days?

- **Target:** the log-return, `log(price at day t+h / price at day t)`. Log-returns make gains and
  losses symmetric and let a 2× and a 0.5× move carry equal weight. Clipped to ±2.5 in training.
- **Two denominations:** chaos (the app's default) and divines. The Divine Orb's chaos price inflates
  a lot over a league, so the divine model is trained separately rather than converted.
- **What matters is ranking.** The app sorts items by predicted change; users act on the top of
  the list. So the main measure of quality is how well the predicted order matches the real
  order, more than the exact number.

## 2. Data

| Source | What it gives | Used for |
| --- | --- | --- |
| poe.ninja history exports | Daily prices for every item across past leagues | Training and validation (`db/history.duckdb`) |
| poe.ninja live API | Today's price and a 7-day sparkline | Live predictions |
| Daily price snapshots (`precompute-data` branch) | The current league's own daily history | The chart; the current league isn't trained on |

The training leagues are listed in `lib/training-leagues.ts`; the results below were measured on
**Settlers, Mercenaries, Keepers, Phrecia 2.0 and Mirage**. Days with
low-confidence prices, and one-day spikes that snap back, are cleaned at ingest
(`scripts/ingest-history.ts`).

A key constraint shapes everything below: **the live league has no daily history of its own** at
prediction time. Only today's price and the last 7 days (the sparkline) are available. Every
feature must be computable from exactly that, plus past leagues.

## 3. The baseline: historical growth

The original predictor, and still the model's strongest input (`lib/growth-ratios.ts`):

1. For each past league, find the item's price near day t and near day t+h (within ±3 days) and
   take the ratio.
2. Require at least **3 leagues** with both prices; otherwise there's no prediction.
3. Average the log-ratios, with every league weighted equally. (Weighting recent leagues more was
   tested and made predictions worse.)
4. **Shrink toward the item's peer group:** blend 50/50 with the average of similar items (same
   category), which tames items whose few leagues happened to be extreme.

This alone ranks well at the very start of a league and close to randomly after day 30.

## 4. Features

All features are built in one place, `lib/prediction-features.ts`, which the live app, the replay
simulator and the training export all call. The chaos model reads 20 of them, the divine model 26.

| Group | Features | Idea |
| --- | --- | --- |
| **Historical growth** | mean, spread and share-up of past leagues' log-ratios; peer-group mean; shrunk baseline | What happened to this item over this stretch before |
| **Price vs history** (mean reversion) | today's log price minus the item's average log price on day t in past leagues; its percentile among all items; a clipped copy | An item priced high compared with its own past tends to fall, a cheap one to rise |
| **Momentum** (from the sparkline) | 1/3/6-day change, 6-day volatility, acceleration, deviation from a 3-day average, momentum percentile, peer-group momentum | Whether a move is under way |
| **Context** | league day, horizon, currency vs item, price in divines | Lets the effects above differ early vs late, short vs long, cheap vs expensive |
| **Divine versions** (divine model only) | the historical-growth and price-vs-history features in divines | Same ideas, without chaos inflation |

Three design choices keep features stable on a live league:

- **Price vs history is compared across the whole market** (the market-wide median is subtracted).
  A league whose chaos prices are all higher (Allflame's Divine Orb was 358c on day 57 vs 130–144c
  before) would otherwise make every item look "expensive".
- **Price tier is measured in divines, not chaos**, for the same reason.
- **Percentiles are computed among the items being scored**, separately for currency and items, so
  they mean the same thing in training and live.

## 5. Models

| Model | What it is | When it's used |
| --- | --- | --- |
| **XGBoost** (`xgb`, default) | Gradient-boosted trees: 200 trees, depth 8, Pseudo-Huber loss (robust to outliers) | Default |
| **Formula** (`formula`) | Ridge regression with separate coefficients per league-day bucket (0, 1–5, 6–29, 30–59, 60+) and per kind | Fallback; ties XGBoost on day 0 and late in a league |
| **Baseline** (`baseline`) | The historical growth average from section 3 | Fallback; items under 1c always use it |
| **Quantile heads** | Two more XGBoost models for the 10th and 90th percentile of the chaos return | "Forecast precision": how wide the model's own range is |

Items under 1c are excluded from training and served the baseline, since tiny prices make
percentage changes meaningless (0.03c → 0.05c is +67%).

The quantile heads answer a different question from the confidence tier. Confidence asks "has
this item gained consistently before?"; precision asks "how sure is the model about this number?"
The two are shown separately and never blended.

## 6. Training

1. **Rows come from the app's own code.** `npm run ml:export-features` replays every past league at
   many (day, horizon) points through the same TypeScript the live app uses, so training and serving
   features can't drift apart. (An earlier Python re-implementation did drift.)
2. **Each row only sees other leagues.** A row from league L is built with L excluded from the
   historical features, exactly like a brand-new league.
3. **Simulate missing sparklines.** About 48% of live items have no usable sparkline, vs 0.3% of
   historical rows. Training drops all momentum features from 45% of rows, so the model learns what
   to do without them.
4. **Fit** with `python ml/fit_production.py all`: XGBoost for chaos and divine, the formula, and the
   quantile heads. The quantile heads use a custom pinball-loss objective, because models trained
   with XGBoost's built-in quantile objective don't reproduce their own predictions from the
   exported trees.
5. **Export** everything to one JSON file, `lib/models/predictor.json` (4.5 MB).

## 7. Validation

**Leave one league out.** Each past league is held out in turn: never used for training, features
or early stopping. Models train on the other four and predict the held-out league as if it were
new. Mirage, the newest, doubles as a forward-in-time test.

**Compared on identical rows.** `scripts/export-backtest-baseline.ts` runs the original predictor on
each held-out league. Every model is scored on exactly those rows, with the same matching rules.

**Metrics:**

| Metric | Meaning |
| --- | --- |
| **Spearman** | Rank correlation between predicted and actual change; the headline metric. "Per-scenario" ranks items within one league/day/horizon, so market-wide moves cancel out |
| **Top-10% hit rate** | Share of the top 10% of suggestions that actually gained |
| **Top-10% return** | Their average log-return |
| **Direction accuracy**, **MAE** | Right sign; average error in log space |

**Checks before trusting any number:**

- the Python pipeline reproduces 100% of production's rows (`check_features.py`);
- no feature can see the future (`check_leakage.py`: erase the future, features unchanged);
- the TypeScript evaluator matches Python to 1e-6 (`npm run ml:parity`);
- a final replay through the app's own code path (`npm run ml:backtest`).

**Robustness tests** perturb the inputs at test time: price noise and missing sparklines.

## 8. Serving in the app

1. **Evaluation in TypeScript.** `lib/prediction-model.ts` walks the exported trees directly; no
   Python or XGBoost runtime is deployed. Scoring ~10k items takes about 0.2 s of CPU.
2. **Precomputed daily.** A GitHub Action runs the model for every horizon from 1 to 30 days and
   publishes `predictions.json`, so pages don't wait on the model
   (`scripts/precompute-predictions.ts`).
3. **Gaps filled.** When a past league's data has a hole, an item can drop below 3 leagues for some
   horizons. Those are filled by interpolation (or held flat past the last real horizon), marked as
   estimates, and given lower confidence (`lib/horizon-fill.ts`).
4. **Chosen with `PREDICTOR`** (`xgb`, `formula`, `baseline`). A missing model file falls back to
   the formula, then the baseline.

## 9. Results

### Headline: Mirage replayed through the app

Model trained without Mirage; features built by the app's TypeScript; league days 0–75,
horizons 3/7/14.

| Model | Spearman | Top-10% hit rate | Top-10% return |
| --- | --- | --- | --- |
| Baseline | 0.185 | 61.7% | 0.313 |
| Formula | 0.324 | 69.7% | 0.581 |
| **XGBoost** | **0.334** | **72.8%** | **0.590** |

| League day | 0 | 3 | 7 | 14 | 30 | 50 | 75 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| XGBoost | 0.60 | 0.51 | 0.35 | 0.25 | 0.32 | 0.21 | 0.24 |
| Formula | 0.60 | 0.50 | 0.32 | 0.23 | 0.30 | 0.22 | 0.26 |
| Baseline | 0.47 | 0.38 | 0.28 | 0.15 | 0.08 | −0.04 | 0.02 |

Divine mode: 0.174 → 0.329.

### All five held-out leagues

**Early league (day 0–25), per-scenario Spearman:**

| Model | All | Day 0 | Day 2–4 | Day 7–10 | Day 14–25 |
| --- | --- | --- | --- | --- | --- |
| Baseline | 0.328 | 0.535 | 0.440 | 0.295 | 0.135 |
| Formula (2 features) | 0.412 | 0.661 | 0.561 | 0.355 | 0.182 |
| Formula per day bucket, + momentum | 0.433 | 0.664 | 0.567 | 0.376 | 0.226 |
| **XGBoost, portable feature set** | **0.471** | 0.682 | 0.593 | 0.419 | 0.284 |
| XGBoost, all 58 candidate features | 0.488 | 0.694 | 0.612 | 0.448 | 0.292 |

- **Top-10% hit rate:** 66.8% (baseline) → 73.1% (formula) → 77.4% (XGBoost).
- **Every held-out league improves.** In the worst league the scores are baseline 0.219, formula
  0.345, XGBoost 0.381.
- **Divine mode:** 0.330 → 0.443.

**Late league (day 30–110):** the baseline is noise (Spearman 0.068, hit rate 48.6%); XGBoost reaches
0.20–0.22 and a 58–60% hit rate. For items ≥ 5c: 0.05 → 0.23.

### Where the gain comes from

- **Mean reversion does most of the work.** XGBoost with only baseline-style inputs barely improves
  (0.343–0.352 vs 0.324). Adding price-vs-history takes it to about 0.48, and it's the top feature by
  importance. A two-feature linear formula captures about 72% of the early-league gain.
- **Momentum matters for currency, not items.** For currency, the last 6 days' change correlates
  +0.24 to +0.34 with the next return; for items it's about 0.
- **The balance shifts over a league.** Fitted on all leagues:

  ```
  early: log-return = 0.273 + 0.973 × historical_growth − 0.543 × price_vs_history
  late:  log-return = 0.191 + 0.257 × historical_growth − 0.324 × price_vs_history
  ```

  Early on the historical ratio is trusted almost fully; late in a league price-vs-history makes
  most of the call.
- **Predictability is front-loaded.** The best single signal scores about 0.6 on day 0 and about
  0.15 by day 14–25. Currency drifts down about 15% in the first 5 days, then rises 20–50% over the
  next 20–30.

### Robustness

| Test (per-scenario Spearman) | Formula | XGBoost | Baseline |
| --- | --- | --- | --- |
| Clean | 0.433 | 0.471 | 0.328 |
| ±10% noise on today's price | 0.426 | 0.449 | |
| ±20% noise | 0.410 | 0.428 | |
| No sparkline for 25% of items | 0.427 | 0.453 | |
| No sparkline at all | 0.408 | 0.419 | |

### Forecast precision

On Mirage, error rises steadily with the predicted spread (0.070 in the narrowest tenth vs 0.592 in
the widest; Spearman 0.50–0.52), so the spread does flag uncertain forecasts. The band is slightly
narrow: 16% of outcomes fell outside each end, against 10%.

## 10. What was tried and rejected

| Idea | Result |
| --- | --- |
| Neural net (MLP) | 0.476 alone, +0.005 in an ensemble; not portable to TypeScript |
| 1D CNN over the raw 7-point sparkline | No gain over the hand-built momentum features (0.260 vs 0.261) |
| Cross-currency lead-lag (X's move predicting Y's) | Weak: real pairs keep their sign on held-out Mirage 55% of the time vs 49% for a shuffled control |
| Learning-to-rank objectives | Worse than regression (0.443 / 0.453 vs 0.479) |
| Weighting past leagues by similarity | No gain |
| Smoothing prices over ±2 days | Net zero; the raw live price is the signal |
| Separate or up-weighted currency models | No gain |
| The item's own longer history (growth since day 0, drawdown) | +0.005; not worth storing |
| Dropping league-wide features (Divine price) | Slightly worse |
| Top-N features by importance | 0.42–0.45; a hand-picked set works better |
| Weighting recent leagues more | Worse than equal weights |
| Whole trend line from one model pass (h=14 + a learned shape) instead of one call per horizon | Matches the per-horizon curve from league day ~3 at less compute; over-predicts short horizons on days 0-2. Not built - the daily precompute scores every horizon instead. See [`trend-line-study.md`](trend-line-study.md) |

## 11. Limits

- **Five training leagues.** Every holdout improved, but each new league is a different economy.
- **Not yet scored on a live league's outcomes.** Log forecasts against what happens before treating
  the absolute numbers as settled.
- **Live sparklines are noisier** than the cleaned history (about twice the volatility).
- **Ranking isn't profit.** Spreads, fees and whether an item can actually be sold aren't modelled.
- **Brand-new items can't be predicted** until past leagues have data for them.
- **Base types with several poe.ninja lines** are trained on the day's average but served the first
  line's price (see `TODO.md`).

Bugs worth knowing about, both fixed: the nearest-day lookup once had no tie-break, so the same query
returned ratios up to 17% apart between runs (now picks the earlier day); and XGBoost's built-in
quantile objective can't be exported faithfully (section 6).

## 12. Reproducing and files

### Retraining the shipped model

The **Retrain model** GitHub workflow (`.github/workflows/retrain-model.yml`) runs all of this on
CPU and opens a pull request; see the main README. By hand:

```bash
npx tsx scripts/retrain-leagues.ts --add <League>   # edits lib/training-leagues.ts, prints holdouts
npx tsx scripts/download-league-history.ts          # poe.ninja exports into POE_DATA_DIR
npm run db:ingest                                   # rebuilds db/history.duckdb
npm run ml:export-features          # ~30 min: training rows from the app's own code
python ml/fit_production.py all     # validation report, writes lib/models/predictor.json
npm run ml:parity                   # TypeScript matches Python
npm run ml:backtest                 # replay Mirage through the app
```

- **Holdouts** default to Mirage and Keepers (`HOLDOUTS=...` overrides). The workflow uses the
  newest training league, as a forward-in-time test, plus Mirage for the backtest.
- The export writes `manifest.json`, so runs cached for an older league set are ignored and
  recomputed.
- `fit_production.py` stores the headline validation scores in `predictor.json` as `validation`;
  `scripts/retrain-report.ts` compares the next run against them.

Commit `lib/training-leagues.ts`, `db/history.duckdb` and `lib/models/predictor.json`. Training uses
an NVIDIA GPU; set `XGB_DEVICE=cpu` without one (the workflow does). Hardware used: XGBoost 3.2 and
PyTorch 2.11 on an RTX 5080.

### Re-running the studies

```bash
python -m venv ml/.venv
ml/.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
ml/.venv/Scripts/python -m pip install -r ml/requirements.txt

npx tsx scripts/export-backtest-baseline.ts                    # ~5 min -> ml/cache/baseline_rows.csv
SCENARIO_SET=late npx tsx scripts/export-backtest-baseline.ts  # -> ml/cache/baseline_rows_late.csv

cd ml && PY=../ml/.venv/Scripts/python
$PY check_features.py && $PY check_leakage.py   # pipeline and leakage checks
$PY run_experiment.py    # early league: baseline vs XGBoost
$PY models_compare.py    # linear vs XGBoost vs MLP
$PY ablation.py          # which features matter
$PY run_late.py          # day 30-110
$PY build_folds.py && $PY explore.py run && $PY explore.py report   # momentum study (~15 min GPU)
$PY trend_analysis.py    # momentum vs mean reversion
$PY robustness.py && $PY robustness2.py && $PY divine_check.py
$PY fit_final.py         # the 2-feature formula's coefficients
```

### Files

| File | Purpose |
| --- | --- |
| `fit_production.py` | **Trains and exports the shipped model**, with a validation report |
| `features.py` | Feature building for the studies (the app uses `lib/prediction-features.ts`) |
| `check_features.py`, `check_leakage.py` | Pipeline and leakage checks |
| `run_experiment.py` | Leave-one-league-out harness and scoring |
| `models_compare.py`, `ablation.py`, `run_late.py` | Model comparison, feature ablations, late league |
| `build_folds.py`, `explore.py`, `trend_analysis.py` | Momentum study |
| `robustness.py`, `robustness2.py`, `divine_check.py` | Noise, missing sparklines, divine mode |
| `fit_final.py` | The simple formula's coefficients |
| `export_model.py`, `eval_model.mjs` | Prototype of the JSON export and JS evaluator |
| `test_quantile_xgb.py` | Quantile spread vs error (superseded by `fit_production.py`) |
| `test_currency_leadlag.py` | Cross-currency lead-lag (weak; not used) |
| `test_sparkline_cnn.py` | CNN over the raw sparkline (no gain; not used) |
| `trend-line-study.md` | Whole-trend-line forecasting study (not shipped) |
