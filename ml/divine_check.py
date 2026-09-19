"""The UI's Chaos/Divine toggle uses a separate divine-denominated prediction (chaos debasement divided out).
Does the momentum-aware model beat production there too? Label = yd (log divine-denominated ratio); production
baseline = its own avgRatioDivine, on the same rows."""
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
import explore as ex
import run_experiment as rx
from features import LEAGUES

DIV = ["refd_mean", "refd_std", "refd_up", "peer_refd_mean", "rel_level_div", "x_now_div"]


def main():
    base = rx.load_baseline()
    base = base[["holdout", "kind", "current_day", "duration", "key", "pred_ratio_div", "actual_ratio_div"]]
    tests, P = [], {"production": [], "xgb PORT+div d8": [], "xgb PORT+div d8 200r": [], "formula (shrunk_div + level pct)": []}
    for h in LEAGUES:
        tr = pd.read_parquet(f"{ex.FOLDS}/{h}_train.parquet")
        te = pd.read_parquet(f"{ex.FOLDS}/{h}_test.parquet")
        te = te.merge(base[base.holdout == h].drop(columns="holdout"), left_on=["kind", "t", "h", "key"],
                      right_on=["kind", "current_day", "duration", "key"], how="inner")
        te = te[te.pred_ratio_div.notna() & te.actual_ratio_div.notna() & (te.actual_ratio_div > 0)].reset_index(drop=True)
        for d in (tr, te):
            d["shrunk_div"] = 0.5 * d.refd_mean + 0.5 * d.peer_refd_mean
        tr = tr.assign(y=tr.yd).dropna(subset=["y"])
        te = te.assign(y=np.log(te.actual_ratio_div.values))
        cols = ex.PORT + DIV
        P["production"].append(np.log(te.pred_ratio_div.values))
        P["xgb PORT+div d8"].append(ex.fit_xgb(tr, cols, {**ex.HUBER, **ex.D8}, 400)[0](te))
        P["xgb PORT+div d8 200r"].append(ex.fit_xgb(tr, cols, {**ex.HUBER, **ex.D8, "eta": 0.1}, 200)[0](te))
        P["formula (shrunk_div + level pct)"].append(ex.ridge(tr.dropna(subset=["shrunk_div"]), te, ["shrunk_div", "rel_level_pct"]))
        tests.append(te[["y", "kind", "t", "h"]].assign(holdout=h))
        print(f"  {h}: {len(te):,} rows", flush=True)
    df = pd.concat(tests, ignore_index=True)
    rows = {}
    for n, parts in P.items():
        gs = ex.group_stats(df.assign(pred=np.concatenate(parts)))
        p = np.concatenate(parts)
        rows[n] = {"per-scn rho": gs.rho.mean(), "top10 logret": gs.top10.mean(), "top10 hit%": gs.hit.mean() * 100,
                   "dir acc%": ((p >= 0) == (df.y.values >= 0)).mean() * 100, "MAE log": np.abs(p - df.y.values).mean()}
        for kind in ("currency",):
            g = gs[gs.kind == kind]
            rows[n]["cur rho"], rows[n]["cur top10"] = g.rho.mean(), g.top10.mean()
    pd.set_option("display.width", 220)
    print("\nDIVINE-denominated target, early league, pooled over 5 holdouts")
    print(pd.DataFrame(rows).T.round(4).to_string())


if __name__ == "__main__":
    main()
