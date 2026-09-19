"""Robustness of the momentum-aware models to what production will really look like:
  (a) live-price mismatch: independent per-item noise on the live 'now' price, applied CONSISTENTLY to everything
      derived from it (level, level rank, momentum, deviation from 3-day mean), at test time only;
  (b) missing sparkline: poe.ninja returns no 7-day sparkline for a share of items (24% of skill gems, 3-21% of
      uniques); those rows lose every momentum feature."""
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
import explore as ex
from features import LEAGUES

NOW_SHIFT = ["x_now", "x_now_div", "rel_level", "rel_level_div", "rel_level_w", "mom1", "mom3", "mom6", "accel",
             "rel_mom6", "rel_mom3", "dev_sm3", "mom6_dm"]
MOM_DROP = ["mom1", "mom3", "mom6", "vol6", "accel", "dev_sm3", "rel_mom6", "rel_mom3", "mom6_pct", "rel_mom6_pct",
            "mom6_dm", "peer_mom6"]
KEYS = ["kind", "t", "h"]


def perturb(te: pd.DataFrame, sigma: float, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    e = rng.normal(0, sigma, len(te)).astype("float32")
    t = te.copy()
    for c in NOW_SHIFT:
        if c in t:
            t[c] = t[c] + e
    t["rel_level_w"] = t["rel_level"].clip(-2, 2)
    t["conv_full"] = t["conv_full"] - e
    for src, dst in (("rel_level", "rel_level_pct"), ("mom6", "mom6_pct"), ("rel_mom6", "rel_mom6_pct")):
        t[dst] = t.groupby(KEYS)[src].rank(pct=True)
    return t


def drop_sparkline(te: pd.DataFrame, frac: float, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    m = rng.random(len(te)) < frac
    t = te.copy()
    for c in MOM_DROP:
        t.loc[m, c] = np.nan
    return t


def main():
    formula = ex.piecewise(ex.cols_mom, by_kind=True)
    settings = [("clean", lambda te: te)] + [(f"noise s={s:.2f}", (lambda s: lambda te: perturb(te, s))(s)) for s in (0.05, 0.10, 0.20, 0.30)] + \
               [(f"no sparkline on {int(f*100)}% of rows", (lambda f: lambda te: drop_sparkline(te, f))(f)) for f in (0.25, 0.50, 1.0)]
    res = {n: {"formula": [], "xgb PORT d8": [], "xgb LIVE2 d8": [], "production": []} for n, _ in settings}
    tests = []
    for h in LEAGUES:
        tr = pd.read_parquet(f"{ex.FOLDS}/{h}_train.parquet")
        te = pd.read_parquet(f"{ex.FOLDS}/{h}_test.parquet")
        pred_port, _ = ex.fit_xgb(tr, ex.PORT, {**ex.HUBER, **ex.D8}, 400)
        pred_full, _ = ex.fit_xgb(tr, [c for c in ex.LIVE2 if c != "cat"], {**ex.HUBER, **ex.D8}, 400)
        tests.append(te[["y", "kind", "t", "h"]].assign(holdout=h))
        for name, fn in settings:
            tp = fn(te)
            res[name]["formula"].append(formula(tr, tp))
            res[name]["xgb PORT d8"].append(pred_port(tp))
            res[name]["xgb LIVE2 d8"].append(pred_full(tp))
            res[name]["production"].append(te.log_pred.values)
        print(f"  {h} done", flush=True)
    df = pd.concat(tests, ignore_index=True)
    rows = {}
    for name, _ in settings:
        rows[name] = {}
        for model, parts in res[name].items():
            gs = ex.group_stats(df.assign(pred=np.concatenate(parts)))
            rows[name][f"{model} rho"] = gs.rho.mean()
            if model != "production":
                rows[name][f"{model} hit%"] = gs.hit.mean() * 100
    out = pd.DataFrame(rows).T
    pd.set_option("display.width", 250)
    print("\nper-scenario Spearman (rho) and top-10% hit rate, pooled over 5 holdouts, early league")
    print(out[[c for c in out.columns if "rho" in c]].round(4).to_string())
    print()
    print(out[[c for c in out.columns if "hit" in c]].round(1).to_string())


if __name__ == "__main__":
    main()
