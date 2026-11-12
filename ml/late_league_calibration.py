"""Is the predictor over-confident late in a league, and can a day-aware calibration fix it?

  1. holdout <League> [--nested]  - fit the production recipe (fit_production.model_json: formula + chaos XGBoost,
     momentum masking) on the OTHER leagues, predict the held-out league's rows, and save them to
     ml/cache/calib/<League>.csv. Default trains on the other leagues' full__ rows, whose reference features were
     built with the held-out league included (mild leakage); --nested uses nested__*__x<League> rows instead (clean,
     only exported for Mirage). One league per process, so several can run at once.
  2. report - calibration by league day for each held-out league and for the current league's backtest rows
     (ml/cache/allflame_backtest_rows.csv from scripts/backtest-current-league.ts --rows-out), then tests a
     calibration (actual ~ a + b * predicted, per day bucket, kind and horizon bucket) fitted only on OTHER leagues.

    ml/.venv/Scripts/python ml/late_league_calibration.py holdout Keepers
    ml/.venv/Scripts/python ml/late_league_calibration.py report
"""
import glob
import os
import sys

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

sys.path.insert(0, os.path.dirname(__file__))
import fit_production as fp  # noqa: E402

OUT = os.path.join(fp.HERE, "cache", "calib")
ALLFLAME = os.path.join(fp.HERE, "cache", "allflame_backtest_rows.csv")
LEAGUES = ["Keepers", "Mercenaries", "Mirage", "Phrecia 2.0", "Settlers"]
DAY_BUCKETS = [(0, 29, "days 0-29"), (30, 59, "days 30-59"), (60, 79, "days 60-79"), (80, 999, "days 80+")]
H_BUCKETS = [(1, 3, "1-3d"), (4, 10, "4-10d"), (11, 20, "11-20d"), (21, 999, "21d+")]


def holdout(league, nested):
    if nested:
        parts = [os.path.basename(p)[:-5] for p in fp.nested_parts(league)]
        tag = "nested"
    else:
        parts = [f"full__{l}" for l in LEAGUES if l != league]
        tag = "full"
    train = fp.augment(fp.tradeable(pd.concat([fp.load(p) for p in parts], ignore_index=True)))
    test = fp.tradeable(fp.load(f"full__{league}"))
    test = test[test.y.notna() & test.shrunk_base.notna()].reset_index(drop=True)
    print(f"{league} ({tag}): train {len(train):,} rows from {parts}, test {len(test):,}", flush=True)
    mj, rt = fp.model_json(train, f"calibration holdout {league}")
    out = pd.DataFrame({
        "t": test.t, "h": test.h, "is_cur": test.is_cur, "y": test.y,
        "xgb": fp.xgb_predict(*rt["chaos"], test),
        "formula": fp.apply_formula(mj["formula"]["chaos"], test),
        "past_avg": test.shrunk_base,
    })
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{league}{'__nested' if nested else ''}.csv")
    out.to_csv(path, index=False)
    print(f"wrote {path}", flush=True)


def bucket(v, buckets):
    for lo, hi, name in buckets:
        if lo <= v <= hi:
            return name
    return None


def stats(pred, y):
    """Calibration of log-ratio predictions: bias, the slope of actual on predicted (1 = right size, <1 = predicted
    moves too big), the top-10% picks' median predicted vs actual move, and median error vs predicting no change."""
    n = len(y)
    if n < 200:
        return None
    vp = np.var(pred)
    slope = np.cov(pred, y)[0, 1] / vp if vp > 0 else np.nan
    top = np.argsort(-pred)[: max(5, n // 10)]
    return {
        "n": n,
        "rho": spearmanr(pred, y).correlation,
        "bias": float(np.mean(pred) - np.mean(y)),
        "slope": float(slope),
        "top_pred": float(np.median(pred[top])),
        "top_act": float(np.median(y[top])),
        "err": float(np.median(np.abs(pred - y))),
        "err_flat": float(np.median(np.abs(y))),
    }


def pct(x):
    return f"{(np.exp(x) - 1) * 100:+.0f}%"


def load_all():
    frames = {}
    for path in sorted(glob.glob(os.path.join(OUT, "*.csv"))):
        name = os.path.basename(path)[:-4].replace("__nested", " (clean)")
        frames[name] = pd.read_csv(path).rename(columns={"xgb": "pred"})
    if os.path.exists(ALLFLAME):
        a = pd.read_csv(ALLFLAME)
        frames["Allflame (live backtest)"] = pd.DataFrame({
            "t": a.day, "h": a.duration, "is_cur": (a.group == "currency").astype(int), "y": a.act, "pred": a.pred,
            "base_type": (a.group == "base type").astype(int),
        })
    for df in frames.values():
        df["day_b"] = df.t.map(lambda v: bucket(v, DAY_BUCKETS))
        df["h_b"] = df.h.map(lambda v: bucket(v, H_BUCKETS))
        df["kind"] = np.where(df.is_cur == 1, "currency", "item")
    return frames


def report():
    frames = load_all()
    print("Calibration of the chaos XGBoost prediction (log ratios; slope 1 = right size, <1 = moves over-predicted)")
    for kind in ("currency", "item"):
        print(f"\n=== {kind}, all horizons pooled ===")
        print(f"{'league':28} {'days':11} {'n':>8} {'rho':>6} {'bias':>7} {'slope':>6}   top-10%: predicted -> actual   err   no-change err")
        for name, df in frames.items():
            d0 = df[df.kind == kind]
            if "base_type" in d0:
                d0 = d0[d0.base_type == 0]
            for _, _, b in DAY_BUCKETS:
                d = d0[d0.day_b == b]
                s = stats(d.pred.values, d.y.values)
                if not s:
                    continue
                print(f"{name:28} {b:11} {s['n']:>8,} {s['rho']:>6.2f} {pct(s['bias']):>7} {s['slope']:>6.2f}   "
                      f"{pct(s['top_pred']):>8} -> {pct(s['top_act']):>7}       {pct(s['err']):>5}   {pct(s['err_flat']):>6}")

    print("\n=== slope by horizon, days 60+ (items and currency together) ===")
    print(f"{'league':28} " + " ".join(f"{b:>8}" for _, _, b in H_BUCKETS))
    for name, df in frames.items():
        d0 = df[(df.t >= 60)]
        if "base_type" in d0:
            d0 = d0[d0.base_type == 0]
        cells = []
        for _, _, hb in H_BUCKETS:
            d = d0[d0.h_b == hb]
            s = stats(d.pred.values, d.y.values)
            cells.append(f"{s['slope']:>8.2f}" if s else f"{'-':>8}")
        print(f"{name:28} " + " ".join(cells))

    # The fix: y ~ a + b*pred per (day bucket, kind, horizon bucket), fitted on the OTHER past leagues' held-out
    # predictions, applied to this one. Allflame uses all five past leagues.
    print("\n=== day-aware calibration, fitted only on other leagues: median error before -> after (days 60+) ===")
    past = {n: f for n, f in frames.items() if n in LEAGUES}
    for name, df in frames.items():
        if name not in LEAGUES and not name.startswith("Allflame"):
            continue
        fit_on = pd.concat([f for n, f in past.items() if n != name], ignore_index=True)
        coefs = {}
        for key, g in fit_on.groupby(["day_b", "kind", "h_b"]):
            if len(g) < 500:
                continue
            yc = g.y.clip(-fp.CLIP, fp.CLIP).values
            b = np.cov(g.pred, yc)[0, 1] / np.var(g.pred)
            coefs[key] = (np.mean(yc) - b * np.mean(g.pred), b)
        d = df[df.t >= 60].copy()
        if "base_type" in d:
            d = d[d.base_type == 0]
        if d.empty:  # Phrecia 2.0 was a short event: no late days
            continue
        ab = d.apply(lambda r: coefs.get((r.day_b, r.kind, r.h_b), (0.0, 1.0)), axis=1, result_type="expand")
        d["cal"] = ab[0] + ab[1] * d.pred
        for kind in ("currency", "item"):
            k = d[d.kind == kind]
            if len(k) < 200:
                continue
            before, after = stats(k.pred.values, k.y.values), stats(k.cal.values, k.y.values)
            print(f"{name:28} {kind:9} err {pct(before['err']):>5} -> {pct(after['err']):>5}   bias {pct(before['bias']):>6} -> "
                  f"{pct(after['bias']):>6}   top-10% predicted {pct(before['top_pred']):>6} -> {pct(after['top_pred']):>6} "
                  f"(actual {pct(before['top_act'])})   rho {before['rho']:.2f} -> {after['rho']:.2f}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"
    if cmd == "holdout":
        holdout(sys.argv[2], "--nested" in sys.argv)
    else:
        report()
