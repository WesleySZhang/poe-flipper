"""Interrogates the XGBoost win: feature-group ablations, tradeable-price subsets, importance."""
import os
import warnings

import numpy as np
import pandas as pd
import xgboost as xgb

warnings.filterwarnings("ignore")
import run_experiment as rx
from features import FEATURE_COLS, LEAGUES, History

ROUNDS = 200

LEVEL = ["x_now", "x_now_div", "rel_level", "rel_level_div", "ref_level_std", "rel_level_pct", "peer_rel_level"]
MACRO = ["macro_div_rel", "div_now", "ref_div_drift"]
CONTEXT = ["t", "h", "cat"]
PROD_LIKE = [
    "n_ref", "ref_mean", "ref_median", "ref_std", "ref_min", "ref_max", "ref_up",
    "nd_ref", "refd_mean", "refd_std", "refd_up", "peer_ref_mean", "peer_refd_mean", "peer_n",
    "shrunk_base", "ref_mean_pct", "ref_pre_mean",
]
GROUPS = {
    "all features": FEATURE_COLS,
    "no level feats (no live price info)": [c for c in FEATURE_COLS if c not in LEVEL],
    "no level, no macro": [c for c in FEATURE_COLS if c not in LEVEL + MACRO],
    "no level, no macro, no t/h/cat  (= production-style inputs only)": PROD_LIKE,
    "only level + macro + t/h/cat (no cross-league ratio stats)": LEVEL + MACRO + CONTEXT,
    "prod-style + t/h/cat": PROD_LIKE + CONTEXT,
    "prod-style + level": PROD_LIKE + LEVEL,
}


def run(folds, n_cat, cols):
    rx.FEATURE_COLS[:] = cols  # to_matrix reads this module-level list
    preds = []
    for h in LEAGUES:
        train, test = folds[h]
        m = rx.fit_xgb(train, n_cat, {}, ROUNDS)
        preds.append(rx.predict_xgb(m, test, n_cat))
    return preds


def pooled(folds, preds):
    df = pd.concat([folds[h][1][["y", "kind", "t", "h", "x_now"]].assign(holdout=h) for h in LEAGUES], ignore_index=True)
    return df, np.concatenate(preds)


def main():
    base = rx.load_baseline()
    cmap = base[base.kind == "currency"].drop_duplicates("key").set_index("key").category.to_dict()
    hist = History(category_map_currency=cmap)
    folds = rx.make_folds(hist, base, 2)
    n_cat = hist.n_categories
    full_cols = list(FEATURE_COLS)

    prod_df = pd.concat([folds[h][1].assign(holdout=h) for h in LEAGUES], ignore_index=True)
    prod_pred = prod_df.log_pred.values

    print("=== ABLATION: pooled over 5 holdouts (XGB, %d rounds, GPU) ===" % ROUNDS)
    rows = {"PRODUCTION": rx.score(prod_df, prod_pred)}
    all_preds = {}
    for name, cols in GROUPS.items():
        preds = run(folds, n_cat, cols)
        df, p = pooled(folds, preds)
        all_preds[name] = p
        rows[name] = rx.score(df, p)
    rx.FEATURE_COLS[:] = full_cols
    cols_show = ["spearman", "spearman_per_scenario", "top10_mean_logret", "top10_pct_gained", "dir_acc", "mae_log"]
    print(pd.DataFrame(rows).T[cols_show].round(4).to_string())

    print("\n=== TRADEABLE-PRICE SUBSETS (all-features XGB vs production; rank quality within subset) ===")
    p_all = all_preds["all features"]
    rows = {}
    price = np.exp(prod_df.x_now.values)
    for lo in [0, 1, 5, 20, 100]:
        m = price >= lo
        sub = prod_df[m]
        s_prod = rx.score(sub, prod_pred[m])
        s_ml = rx.score(sub, p_all[m])
        rows[f"price >= {lo}c  (n={m.sum():,})"] = {
            "prod spearman": s_prod["spearman"], "xgb spearman": s_ml["spearman"],
            "prod top10 logret": s_prod["top10_mean_logret"], "xgb top10 logret": s_ml["top10_mean_logret"],
            "prod top10 %gain": s_prod["top10_pct_gained"], "xgb top10 %gain": s_ml["top10_pct_gained"],
        }
    print(pd.DataFrame(rows).T.round(4).to_string())

    print("\n=== BY KIND ===")
    rows = {}
    for kind in ["currency", "item"]:
        m = (prod_df.kind == kind).values
        sub = prod_df[m]
        rows[kind] = {
            "n": m.sum(),
            "prod spearman": rx.score(sub, prod_pred[m])["spearman"],
            "xgb spearman": rx.score(sub, p_all[m])["spearman"],
        }
    print(pd.DataFrame(rows).T.round(4).to_string())

    print("\n=== FEATURE IMPORTANCE (gain), model trained with Mirage held out ===")
    train, test = folds["Mirage"]
    m = rx.fit_xgb(train, n_cat, {}, ROUNDS)
    imp = pd.Series(m.get_score(importance_type="total_gain")).sort_values(ascending=False)
    print((imp / imp.sum()).round(4).head(15).to_string())


if __name__ == "__main__":
    main()
