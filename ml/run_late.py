"""Late-league test (day 30-110): the regime the app is in today (Allflame ~day 57), and where the app's
own warning says predictions get unreliable. Same leave-one-league-out protocol as run_experiment.py."""
import time
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
import os
import run_experiment as rx
from features import FEATURE_COLS, LEAGUES, SCENARIOS as EARLY, History, build_dataset
from models_compare import fit_ridge

CACHE = rx.CACHE
LATE_START = [30, 35, 40, 50, 60, 75, 90, 110]
LATE_DUR = [3, 7, 14, 21, 30]
LATE = [(t, h) for t in LATE_START for h in LATE_DUR if t + h <= 133]


def main():
    t0 = time.time()
    early_base = rx.load_baseline()
    cmap = early_base[early_base.kind == "currency"].drop_duplicates("key").set_index("key").category.to_dict()
    base = pd.read_csv(os.path.join(CACHE, "baseline_rows_late.csv"))
    base["y_prod"] = np.log(base.actual_ratio)
    base["log_pred"] = np.log(base.pred_ratio)
    print(f"late baseline rows: {len(base):,}; by holdout:\n{base.groupby('holdout').size().to_string()}")

    hist = History(category_map_currency=cmap, max_day=133)
    n_cat = hist.n_categories
    holdouts = [h for h in LEAGUES if (base.holdout == h).any()]
    print(f"history ready ({time.time()-t0:.0f}s); holdouts with late data: {holdouts}")

    preds = {k: [] for k in ["production", "linear2", "xgb_late_only", "xgb_early+late"]}
    tests = []
    for h in holdouts:
        train_leagues = [l for l in LEAGUES if l != h]
        tr_late, tr_early = [], []
        for lt in train_leagues:
            refs = [l for l in train_leagues if l != lt]
            tr_late.append(build_dataset(hist, lt, refs, min_ref=2, scenarios=LATE))
            tr_early.append(build_dataset(hist, lt, refs, min_ref=2, scenarios=EARLY))
        tr_late = pd.concat(tr_late, ignore_index=True)
        tr_all = pd.concat([tr_late] + tr_early, ignore_index=True)

        test = build_dataset(hist, h, train_leagues, min_ref=3, scenarios=LATE)
        b = base[base.holdout == h]
        test = test.merge(
            b[["kind", "current_day", "duration", "key", "pred_ratio", "log_pred", "confidence"]],
            left_on=["kind", "t", "h", "key"], right_on=["kind", "current_day", "duration", "key"], how="inner",
        )
        print(f"\n{h}: train late-only {len(tr_late):,}  early+late {len(tr_all):,}  test {len(test):,}  ({time.time()-t0:.0f}s)", flush=True)
        tests.append(test.assign(holdout=h))
        preds["production"].append(test.log_pred.values)
        preds["linear2"].append(fit_ridge(tr_late, ["shrunk_base", "rel_level_pct"])(test))
        preds["xgb_late_only"].append(rx.predict_xgb(rx.fit_xgb(tr_late, n_cat, {"objective": "reg:pseudohubererror", "huber_slope": 0.5}, 300), test, n_cat))
        preds["xgb_early+late"].append(rx.predict_xgb(rx.fit_xgb(tr_all, n_cat, {"objective": "reg:pseudohubererror", "huber_slope": 0.5}, 300), test, n_cat))

    df = pd.concat(tests, ignore_index=True)
    P = {k: np.concatenate(v) for k, v in preds.items()}
    cols = ["spearman", "spearman_per_scenario", "top10_mean_logret", "top10_pct_gained", "dir_acc", "mae_log"]

    print("\n================ LATE LEAGUE (day 30-110): POOLED ================")
    print(pd.DataFrame({k: rx.score(df, p) for k, p in P.items()}).T[cols].round(4).to_string())

    print("\n================ SPEARMAN PER HOLDOUT ================")
    tab = {}
    for k, p in P.items():
        tab[k] = {}
        for h in holdouts:
            m = (df.holdout == h).values
            tab[k][h] = rx.score(df[m].drop(columns="holdout"), p[m])["spearman"]
    print(pd.DataFrame(tab).T.round(4).to_string())

    print("\n================ BY LEAGUE DAY (t) ================")
    rows = {}
    for lo, hi in [(30, 39), (40, 59), (60, 89), (90, 110)]:
        m = ((df.t >= lo) & (df.t <= hi)).values
        rows[f"t {lo}-{hi} (n={m.sum():,})"] = {
            "prod": rx.score(df[m], P["production"][m])["spearman"],
            "linear2": rx.score(df[m], P["linear2"][m])["spearman"],
            "xgb": rx.score(df[m], P["xgb_early+late"][m])["spearman"],
            "prod top10 logret": rx.score(df[m], P["production"][m])["top10_mean_logret"],
            "xgb top10 logret": rx.score(df[m], P["xgb_early+late"][m])["top10_mean_logret"],
        }
    print(pd.DataFrame(rows).T.round(4).to_string())

    print("\n================ TRADEABLE PRICE SUBSETS (xgb early+late vs production) ================")
    rows = {}
    price = np.exp(df.x_now.values)
    for lo in [0, 5, 20, 100]:
        m = price >= lo
        a, b2 = rx.score(df[m], P["production"][m]), rx.score(df[m], P["xgb_early+late"][m])
        rows[f">= {lo}c (n={m.sum():,})"] = {"prod spearman": a["spearman"], "xgb spearman": b2["spearman"],
                                             "prod top10 %gain": a["top10_pct_gained"], "xgb top10 %gain": b2["top10_pct_gained"]}
    print(pd.DataFrame(rows).T.round(4).to_string())
    print(f"\ntotal {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
