"""Robustness of the mean-reversion signal: (a) divine-denominated targets, (b) sensitivity to live-price
measurement mismatch (live API vs historical export) via injected noise at test time only."""
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
import run_experiment as rx
from features import FEATURE_COLS, LEAGUES, History
from models_compare import fit_ridge

rx.FEATURE_COLS[:] = FEATURE_COLS
HUBER = {"objective": "reg:pseudohubererror", "huber_slope": 0.5}


def perturb(test: pd.DataFrame, sigma: float, seed: int = 0) -> pd.DataFrame:
    """Simulate a mismatch between the live price feed and the historical export the level features were
    trained on: independent per-item log noise on the item's 'price now'."""
    rng = np.random.default_rng(seed)
    e = rng.normal(0, sigma, len(test)).astype("float32")
    t = test.copy()
    for c in ["x_now", "x_now_div", "rel_level", "rel_level_div"]:
        t[c] = t[c] + e
    t["rel_level_pct"] = t.groupby(["kind", "t", "h"])["rel_level"].rank(pct=True)
    return t


def main():
    base = rx.load_baseline()
    cmap = base[base.kind == "currency"].drop_duplicates("key").set_index("key").category.to_dict()
    hist = History(category_map_currency=cmap)
    folds = rx.make_folds(hist, base, 2)
    n_cat = hist.n_categories

    # ---------- (a) divine-denominated target
    print("=== (a) DIVINE-DENOMINATED predictions (real value change, chaos debasement removed) ===")
    dfs, P = [], {"production": [], "linear2": [], "xgb": []}
    for h in LEAGUES:
        train, test = folds[h]
        b = base[base.holdout == h][["kind", "current_day", "duration", "key", "pred_ratio_div", "actual_ratio_div"]]
        test = test.merge(b, left_on=["kind", "t", "h", "key"], right_on=["kind", "current_day", "duration", "key"], how="inner")
        test = test[test.pred_ratio_div.notna() & test.actual_ratio_div.notna() & (test.actual_ratio_div > 0)]
        tr = train.assign(y=train.yd).dropna(subset=["y"])
        test = test.assign(y=np.log(test.actual_ratio_div), holdout=h)
        dfs.append(test[["y", "kind", "t", "h", "holdout"]])
        P["production"].append(np.log(test.pred_ratio_div.values))
        P["linear2"].append(fit_ridge(tr, ["refd_mean", "rel_level_pct"])(test))
        P["xgb"].append(rx.predict_xgb(rx.fit_xgb(tr, n_cat, HUBER, 300), test, n_cat))
    df = pd.concat(dfs, ignore_index=True)
    cols = ["spearman", "spearman_per_scenario", "top10_mean_logret", "top10_pct_gained", "dir_acc", "mae_log"]
    print(pd.DataFrame({k: rx.score(df, np.concatenate(v)) for k, v in P.items()}).T[cols].round(4).to_string())

    # ---------- (b) sensitivity to live-price mismatch
    print("\n=== (b) SENSITIVITY: independent per-item noise on the live 'price now' (test time only) ===")
    print("    sigma 0.10 ~ a typical +/-10% disagreement between live API and historical export, per item")
    models = []
    for h in LEAGUES:
        train, test = folds[h]
        models.append((fit_ridge(train, ["shrunk_base", "rel_level_pct"]), rx.fit_xgb(train, n_cat, HUBER, 300)))
    rows = {}
    for sigma in [0.0, 0.05, 0.10, 0.20, 0.30, 0.50]:
        dfl, pl, px = [], [], []
        for (h, (lin, xg)) in zip(LEAGUES, models):
            test = folds[h][1]
            tp = perturb(test, sigma) if sigma > 0 else test
            dfl.append(test[["y", "kind", "t", "h"]].assign(holdout=h))
            pl.append(lin(tp))
            px.append(rx.predict_xgb(xg, tp, n_cat))
        d = pd.concat(dfl, ignore_index=True)
        sl, sx = rx.score(d, np.concatenate(pl)), rx.score(d, np.concatenate(px))
        rows[f"sigma={sigma:.2f}"] = {
            "linear2 spearman": sl["spearman"], "xgb spearman": sx["spearman"],
            "linear2 top10 %gain": sl["top10_pct_gained"], "xgb top10 %gain": sx["top10_pct_gained"],
        }
    allf = pd.concat([folds[h][1][["y", "kind", "t", "h"]].assign(holdout=h) for h in LEAGUES], ignore_index=True)
    prod = rx.score(allf, np.concatenate([folds[h][1].log_pred.values for h in LEAGUES]))
    print(pd.DataFrame(rows).T.round(4).to_string())
    print(f"\n(production for reference: spearman {prod['spearman']:.4f}, top10 %gain {prod['top10_pct_gained']:.4f})")


if __name__ == "__main__":
    main()
