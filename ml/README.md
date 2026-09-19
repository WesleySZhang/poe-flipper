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
  production).
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
