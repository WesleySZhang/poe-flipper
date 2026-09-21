"""EXPLORATORY (superseded) - answers the research question this asks, but uses XGBoost's built-in
reg:quantileerror objective, which turned out to be undeployable: its serialized JSON tree dump does not
reproduce its own predict() output on XGBoost 3.2.0 (verified exhaustively - see the comment above QUANTILES
in fit_production.py), so a hand-rolled TypeScript tree evaluator (the only option for a plain Vercel function)
cannot use it. The SHIPPED quantile heads (fit_production.py's fit_xgb_quantile/pinball_objective) instead use a
custom pinball-loss objective, which serializes correctly (parity 1e-6, npm run ml:parity) and, empirically,
calibrates as well or better. This file is kept for its result (does the signal exist at all) and its
methodology (spread-vs-error checks), not as the reproduction path for the shipped model - use
`python fit_production.py validate` for that.

Test: does quantile XGBoost (predict p10/p50/p90 of the log-return instead of a point estimate) beat the
shipped point model, and does the predicted spread (p90-p10) correlate with actual error - i.e. would it make a
usable, calibrated confidence signal to complement/replace lib/confidence.ts's heuristic score?

Same Mirage holdout / nested-exclusion protocol as fit_production.py, same CHAOS_COLS feature set, so results are
directly comparable to the shipped model's validation numbers.

    python test_quantile_xgb.py
"""
import glob
import os
import warnings

import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.stats import spearmanr

warnings.filterwarnings("ignore")
from fit_production import CHAOS_COLS, CLIP, ROWS, XGB_PARAMS, augment, load, report, tradeable

QUANTILES = [0.1, 0.5, 0.9]


def fit_quantile(train, cols, q):
    d = train[train.y.notna()]
    dm = xgb.DMatrix(d[cols].values.astype("float32"), label=d.y.clip(-CLIP, CLIP).values, feature_names=cols)
    params = {**XGB_PARAMS, "objective": "reg:quantileerror", "quantile_alpha": q}
    params.pop("huber_slope", None)
    return xgb.train(params, dm, num_boost_round=200)


def predict(m, cols, df):
    return m.predict(xgb.DMatrix(df[cols].values.astype("float32"), feature_names=cols))


def pinball_loss(y, pred, q):
    e = y - pred
    return np.mean(np.maximum(q * e, (q - 1) * e))


def main(holdout="Mirage"):
    parts = sorted(glob.glob(os.path.join(ROWS, f"nested__*__x{holdout}.json")))
    train = augment(tradeable(pd.concat([load(os.path.basename(p)[:-5]) for p in parts], ignore_index=True)))
    test = tradeable(load(f"full__{holdout}"))
    test = test[test.y.notna()].reset_index(drop=True)
    print(f"holdout {holdout}: train {len(train):,} rows, test {len(test):,} rows")

    # ---- point model (same recipe as the shipped chaos model) for comparison
    from fit_production import fit_xgb
    point_model, cols = fit_xgb(train, "chaos")
    point_pred = predict(point_model, cols, test)

    # ---- quantile models
    qmodels = {q: fit_quantile(train, CHAOS_COLS, q) for q in QUANTILES}
    qpred = {q: predict(qmodels[q], CHAOS_COLS, test) for q in QUANTILES}

    # 1. Does the quantile p50 rank as well as the point model? (they should be close - same features/data)
    report(f"{holdout} holdout: point model vs quantile median (p50)", test,
           {"production": test.shrunk_base.values, "point (shipped-style)": point_pred, "quantile p50": qpred[0.5]}, "y")

    # 2. Calibration: are actual outcomes below p10 about 10% of the time, and below p90 about 90%?
    y = test.y.values
    below10 = (y < qpred[0.1]).mean()
    below50 = (y < qpred[0.5]).mean()
    below90 = (y < qpred[0.9]).mean()
    print(f"\ncalibration (should be ~0.10 / ~0.50 / ~0.90): P(y < p10) = {below10:.3f}, "
          f"P(y < p50) = {below50:.3f}, P(y < p90) = {below90:.3f}")
    print(f"pinball loss - p10: {pinball_loss(y, qpred[0.1], 0.1):.4f}  p50: {pinball_loss(y, qpred[0.5], 0.5):.4f}  "
          f"p90: {pinball_loss(y, qpred[0.9], 0.9):.4f}")

    # 3. Does the predicted spread (p90-p10) actually correlate with realised error? If so, it's a USABLE per-item
    #    confidence signal - narrower spread should mean the point forecast is more trustworthy.
    spread = qpred[0.9] - qpred[0.1]
    abs_err = np.abs(point_pred - y)
    rho_spread_err = spearmanr(spread, abs_err)[0]
    print(f"\nSpearman(predicted spread p90-p10, |point pred - actual|) = {rho_spread_err:.3f}  "
          f"(positive => spread is a real, useful confidence signal)")

    # 4. Direct calibration check: does mean |error| climb monotonically across spread deciles, pooled over ALL
    #    rows (not conditioned on being a top-decile PICK, which is a noisier, differently-selected slice and
    #    washed out the signal in an earlier version of this script - see git history). This is the check that
    #    actually answers "is the spread usable as a confidence signal": yes, if error rises with spread.
    df = pd.DataFrame({"pred": point_pred, "spread": spread, "y": y})
    df["spread_decile"] = pd.qcut(df.spread, 10, labels=False, duplicates="drop")
    g = df.groupby("spread_decile").apply(
        lambda d: pd.Series({"mean_abs_err": np.abs(d.pred - d.y).mean(), "mean_spread": d.spread.mean(), "n": len(d)})
    )
    print(f"\nmean |point-pred - actual| by predicted-spread decile (0=narrowest, 9=widest), pooled over all {len(df):,} rows:")
    print(g.round(4).to_string())
    monotonic = (g.mean_abs_err.diff().dropna() > 0).all()
    print(f"strictly monotonic increase: {monotonic}  "
          f"(narrowest-decile error {g.mean_abs_err.iloc[0]:.3f} vs widest {g.mean_abs_err.iloc[-1]:.3f}, "
          f"{g.mean_abs_err.iloc[-1]/g.mean_abs_err.iloc[0]:.1f}x)")


if __name__ == "__main__":
    main()
