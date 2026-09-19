"""
Leave-one-league-out comparison: production model vs ML models, scored on production's exact rows.

For each outer holdout league H:
  * training rows come from the other 4 leagues, each one used as a "target" whose features are built
    from the OTHER 3 training leagues only (nested exclusion - a training row's own league never
    contributes to its own features, exactly like production predicting a brand-new league);
  * test rows are production's matched rows for H, with features built from all 4 training leagues.
H's data is never seen in training, feature construction, or early-stopping.
"""
from __future__ import annotations

import argparse
import os
import time

import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.stats import spearmanr

from features import FEATURE_COLS, LEAGUES, History, build_dataset

CACHE = os.path.join(os.path.dirname(__file__), "cache")
Y_CLIP = 2.5  # ~12x; label clipping only affects training, never scoring


def load_baseline() -> pd.DataFrame:
    base = pd.read_csv(os.path.join(CACHE, "baseline_rows.csv"))
    base["y_prod"] = np.log(base.actual_ratio)
    base["log_pred"] = np.log(base.pred_ratio)
    return base


def make_folds(hist: History, base: pd.DataFrame, min_ref_train: int):
    folds = {}
    for holdout in LEAGUES:
        train_leagues = [l for l in LEAGUES if l != holdout]
        train_parts = []
        for lt in train_leagues:
            refs = [l for l in train_leagues if l != lt]
            train_parts.append(build_dataset(hist, lt, refs, min_ref=min_ref_train))
        train = pd.concat(train_parts, ignore_index=True)

        test = build_dataset(hist, holdout, train_leagues, min_ref=3)
        b = base[base.holdout == holdout]
        test = test.merge(
            b[["kind", "current_day", "duration", "key", "pred_ratio", "log_pred", "confidence"]],
            left_on=["kind", "t", "h", "key"],
            right_on=["kind", "current_day", "duration", "key"],
            how="inner",
        )
        folds[holdout] = (train, test)
    return folds


def to_matrix(df: pd.DataFrame, n_cat: int) -> pd.DataFrame:
    X = df[FEATURE_COLS].copy()
    if "cat" in X.columns:
        X["cat"] = pd.Categorical(X["cat"], categories=list(range(n_cat)))
    return X.astype({c: "float32" for c in FEATURE_COLS if c != "cat"})


# ----------------------------------------------------------------------------- metrics

def scenario_groups(df: pd.DataFrame):
    return df.groupby(["kind", "t", "h"], sort=False)


def score(df: pd.DataFrame, pred: np.ndarray) -> dict:
    y = df.y.values
    d = pd.DataFrame({"pred": pred, "y": y, "kind": df.kind.values, "t": df.t.values, "h": df.h.values})
    group_cols = ["kind", "t", "h"]
    if "holdout" in df.columns:  # pooled scoring: a scenario is (league, kind, t, h), never merged across leagues
        d["holdout"] = df.holdout.values
        group_cols = ["holdout"] + group_cols
    out = {"n": len(d)}
    out["spearman"] = spearmanr(d.pred, d.y)[0]
    per = []
    top10, top5, top10_gain, top5_gain = [], [], [], []
    for _, g in d.groupby(group_cols, sort=False):
        if len(g) < 20:
            continue
        per.append(spearmanr(g.pred, g.y)[0])
        n10 = max(5, int(len(g) * 0.10))
        n5 = max(3, int(len(g) * 0.05))
        s = g.sort_values("pred", ascending=False)
        top10.append(s.y.iloc[:n10].mean())
        top5.append(s.y.iloc[:n5].mean())
        top10_gain.append((s.y.iloc[:n10] > 0).mean())
        top5_gain.append((s.y.iloc[:n5] > 0).mean())
    out["spearman_per_scenario"] = float(np.nanmean(per))
    out["top10_mean_logret"] = float(np.mean(top10))
    out["top5_mean_logret"] = float(np.mean(top5))
    out["top10_pct_gained"] = float(np.mean(top10_gain))
    out["dir_acc"] = float(((d.pred >= 0) == (d.y >= 0)).mean())
    out["mae_ratio"] = float(np.abs(np.exp(d.pred) - np.exp(d.y)).mean())
    out["mae_log"] = float(np.abs(d.pred - d.y).mean())
    out["all_mean_logret"] = float(d.y.mean())
    return out


# ----------------------------------------------------------------------------- models

def fit_xgb(train: pd.DataFrame, n_cat: int, params: dict, rounds: int, target: str = "y"):
    y = train[target].clip(-Y_CLIP, Y_CLIP).values
    dtrain = xgb.DMatrix(to_matrix(train, n_cat), label=y, enable_categorical=True)
    p = {
        "device": "cuda",
        "tree_method": "hist",
        "objective": "reg:squarederror",
        "max_depth": 6,
        "eta": 0.05,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "min_child_weight": 100,
        "reg_lambda": 10.0,
        "max_cat_to_onehot": 1,
        "seed": 0,
        **params,
    }
    return xgb.train(p, dtrain, num_boost_round=rounds)


def predict_xgb(model, test: pd.DataFrame, n_cat: int, upto: int | None = None) -> np.ndarray:
    d = xgb.DMatrix(to_matrix(test, n_cat), enable_categorical=True)
    return model.predict(d, iteration_range=(0, upto) if upto else (0, 0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=400)
    ap.add_argument("--min-ref-train", type=int, default=2)
    args = ap.parse_args()

    t0 = time.time()
    base = load_baseline()
    cmap = base[base.kind == "currency"].drop_duplicates("key").set_index("key").category.to_dict()
    hist = History(category_map_currency=cmap)
    folds = make_folds(hist, base, args.min_ref_train)
    n_cat = hist.n_categories
    print(f"folds built in {time.time()-t0:.0f}s")
    for h, (tr, te) in folds.items():
        print(f"  {h:12s} train rows {len(tr):>9,}   test rows {len(te):>9,}")

    checkpoints = [50, 100, 200, args.rounds]
    results = {}  # (variant) -> list of per-fold score dicts
    pooled = {}  # variant -> list of (df, pred)

    def record(variant, holdout, df, pred):
        results.setdefault(variant, {})[holdout] = score(df, pred)
        pooled.setdefault(variant, []).append((df, pred))

    for holdout, (train, test) in folds.items():
        print(f"\n--- holdout {holdout} ---", flush=True)
        record("production", holdout, test, test.log_pred.values)
        record("my_shrunk_base", holdout, test, test.shrunk_base.fillna(0).values)

        tt = time.time()
        model = fit_xgb(train, n_cat, {}, args.rounds)
        print(f"  xgb (GPU) fit in {time.time()-tt:.1f}s", flush=True)
        for r in checkpoints:
            pred = predict_xgb(model, test, n_cat, upto=r)
            record(f"xgb_{r}", holdout, test, pred)
            s = results[f"xgb_{r}"][holdout]
            print(f"  xgb rounds={r:4d}: spearman={s['spearman']:.4f}  per-scn={s['spearman_per_scenario']:.4f}  "
                  f"top10 logret={s['top10_mean_logret']:+.4f}", flush=True)
        p = results["production"][holdout]
        print(f"  production        : spearman={p['spearman']:.4f}  per-scn={p['spearman_per_scenario']:.4f}  "
              f"top10 logret={p['top10_mean_logret']:+.4f}")

    # ---- summary tables
    cols = ["spearman", "spearman_per_scenario", "top10_mean_logret", "top10_pct_gained", "dir_acc", "mae_log"]
    print("\n================ PER-HOLDOUT SPEARMAN (pooled within league) ================")
    tab = pd.DataFrame({v: {h: results[v][h]["spearman"] for h in LEAGUES} for v in results}).T
    tab["mean"] = tab.mean(1)
    print(tab.round(4).to_string())

    print("\n================ POOLED ACROSS ALL 5 HOLDOUTS ================")
    rows = {}
    for v, parts in pooled.items():
        df = pd.concat([p[0][["y", "kind", "t", "h"]].assign(holdout=h) for p, h in zip(parts, LEAGUES)], ignore_index=True)
        pred = np.concatenate([p[1] for p in parts])
        s = score(df, pred)
        rows[v] = {c: s[c] for c in cols}
    print(pd.DataFrame(rows).T.round(4).to_string())
    print(f"\ntotal {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
