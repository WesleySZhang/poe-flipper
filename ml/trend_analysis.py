"""What do the data actually say about trends / momentum? Descriptive, on the held-out test rows of all five
leagues (production's matched rows). Cross-sectional statistics: within each (league, kind, t, h) scenario we
rank items, so market-wide moves cancel and only relative behaviour is measured."""
import os
import warnings

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

warnings.filterwarnings("ignore")
import run_experiment as rx
from features import LEAGUES

FOLDS = os.path.join(rx.CACHE, "folds")
SIGNALS = ["shrunk_base", "shrunk_sm", "rel_level_pct", "rel_level_sm_pct", "dev_sm3", "mom1", "mom3", "mom6",
           "rel_mom6", "accel", "vol6", "analog_mom", "peer_mom6"]


def tb(t):
    return np.select([t == 0, t <= 4, t <= 10], ["t=0", "t=2-4", "t=7-10"], "t=14-25")


def hb(h):
    return np.select([h <= 5, h <= 14], ["h<=5", "h=7-14"], "h=20-30")


def main():
    cols = ["y", "kind", "t", "h"] + SIGNALS
    df = pd.concat([pd.read_parquet(os.path.join(FOLDS, f"{h}_test.parquet"), columns=cols).assign(holdout=h) for h in LEAGUES],
                   ignore_index=True)
    df["tb"], df["hb"] = tb(df.t.values), hb(df.h.values)
    pd.set_option("display.width", 220)

    # ---- 1. market-wide drift: the 'exponential growth at the start'
    print("=== 1. Average log-return of everything in the scenario (market drift), by start day x horizon ===")
    print("    (log 0.69 = price doubled, 0.41 = +50%)")
    for kind in ("currency", "item"):
        g = df[df.kind == kind].groupby(["t", "hb"]).y.mean().unstack().round(3)
        print(f"\n{kind}:\n{g.to_string()}")
    disp = df.groupby(["kind", "tb"]).apply(lambda g: g.groupby(["holdout", "t", "h"]).y.std().mean()).unstack().round(3)
    print("\nCross-sectional dispersion (std of log-return across items within a scenario) - the room for stock-picking:")
    print(disp.to_string())

    # ---- 2. which signals rank items correctly, by day bucket
    print("\n=== 2. Per-scenario Spearman of each signal vs the realised return (sign matters: negative = mean reversion) ===")
    for kind in ("currency", "item"):
        rows = {}
        for s in SIGNALS:
            per = []
            for (ho, t, h), g in df[df.kind == kind].groupby(["holdout", "t", "h"], sort=False):
                gg = g[[s, "y"]].dropna()
                if len(gg) >= 30 and gg[s].nunique() > 3:
                    per.append((tb(np.array([t]))[0], spearmanr(gg[s], gg.y)[0]))
            p = pd.DataFrame(per, columns=["tb", "rho"])
            rows[s] = p.groupby("tb").rho.mean().reindex(["t=0", "t=2-4", "t=7-10", "t=14-25"])
        print(f"\n{kind}:")
        print(pd.DataFrame(rows).T.round(3).to_string())

    # ---- 3. does momentum continue or revert, by horizon?
    print("\n=== 3. mom6 (last-6-day change) vs return: Spearman by horizon, t>=7 ===")
    rows = {}
    for kind in ("currency", "item"):
        for hbk, gh in df[(df.kind == kind) & (df.t >= 7)].groupby("hb"):
            per = [spearmanr(g.mom6.dropna(), g.loc[g.mom6.notna(), "y"])[0]
                   for _, g in gh.groupby(["holdout", "t", "h"]) if g.mom6.notna().sum() >= 30]
            rows.setdefault(kind, {})[hbk] = np.mean(per)
    print(pd.DataFrame(rows).T.round(3).to_string())

    # ---- 4. level x momentum grid: are expensive-and-still-rising items the ones that fall?
    print("\n=== 4. Mean log-return by (price vs history) x (6-day momentum) tercile, items, t>=7 ===")
    sub = df[(df.kind == "item") & (df.t >= 7)].dropna(subset=["rel_level_pct", "mom6"]).copy()
    sub["lvl"] = pd.cut(sub.rel_level_pct, [0, 1 / 3, 2 / 3, 1.0], labels=["cheap vs hist", "mid", "expensive vs hist"], include_lowest=True)
    sub["mom_t"] = sub.groupby(["holdout", "t", "h"]).mom6.transform(lambda s: pd.qcut(s.rank(method="first"), 3, labels=["falling", "flat", "rising"]))
    print(sub.groupby(["lvl", "mom_t"]).y.mean().unstack().round(3).to_string())
    print("\n(count per cell)")
    print(sub.groupby(["lvl", "mom_t"]).y.size().unstack().to_string())


if __name__ == "__main__":
    main()
