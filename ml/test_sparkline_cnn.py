"""Test: does a sequence model (1D CNN) over the RAW 7-point sparkline path beat the hand-built momentum
scalars (mom1/mom3/mom6/vol6/accel/dev_sm3) already in the shipped model? If the scalars already capture what
there is to learn from 7 points, a CNN should not beat them - a 7-step sequence is short enough that a few
well-chosen summary statistics can plausibly saturate it, which is the argument made against RNN/CNN before
actually testing it. This closes that argument empirically instead of by assertion.

Uses scripts/export-sparkline-paths.ts's rows (raw 7-point relative log-price path, t, h, is_cur, shrunk_base,
rel_level_pct, y, yd), restricted to rows with a COMPLETE path (see that script) so the comparison isn't
confounded by missingness-handling differences between the CNN and the scalar-feature XGBoost.

Same Mirage holdout / nested-exclusion protocol as fit_production.py.

    python test_sparkline_cnn.py
"""
import glob
import json
import os
import warnings

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import xgboost as xgb
from scipy.stats import spearmanr

warnings.filterwarnings("ignore")
HERE = os.path.dirname(__file__)
ROWS = os.path.join(HERE, "cache", "tsrows")
CLIP = 2.5
SPARK_POINTS = 7
DEV = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def load_spark(label):
    meta = json.load(open(os.path.join(ROWS, f"spark__{label}.json")))
    cols = meta["columns"]
    a = np.fromfile(os.path.join(ROWS, f"spark__{label}.f32"), dtype=np.float32).reshape(-1, len(cols))
    return pd.DataFrame(a, columns=cols)


def score(df, pred, ycol="y"):
    d = pd.DataFrame({"p": pred, "y": df[ycol].values, "t": df.t.values, "h": df.h.values, "c": df.is_cur.values})
    d = d[d.y.notna() & d.p.notna()]
    rows = []
    for (t, h, c), g in d.groupby(["t", "h", "c"], sort=False):
        if len(g) < 20:
            continue
        y = g.y.values[np.argsort(-g.p.values, kind="stable")]
        n10 = max(5, int(len(g) * 0.10))
        rows.append((t, c, spearmanr(g.p, g.y)[0], y[:n10].mean(), (y[:n10] > 0).mean()))
    r = pd.DataFrame(rows, columns=["t", "cur", "rho", "top10", "hit"])
    return r


def report(name, results):
    print(f"\n=== {name} ===")
    tab = {}
    for k, r in results.items():
        tab[k] = {"per-scn rho": r.rho.mean(), "top10 hit%": r.hit.mean() * 100, "top10 logret": r.top10.mean()}
    print(pd.DataFrame(tab).T.round(4).to_string())


class SparkCNN(nn.Module):
    """1D conv over the 7-point path, concatenated with the same scalar context (t, h, is_cur, shrunk_base,
    rel_level_pct) the scalar-feature model gets, so the comparison isolates the sparkline representation."""

    def __init__(self, n_ctx=5):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv1d(1, 16, kernel_size=3, padding=1), nn.GELU(),
            nn.Conv1d(16, 16, kernel_size=3, padding=1), nn.GELU(),
        )
        self.head = nn.Sequential(
            nn.Linear(16 * SPARK_POINTS + n_ctx, 64), nn.GELU(), nn.Dropout(0.1),
            nn.Linear(64, 32), nn.GELU(), nn.Linear(32, 1),
        )

    def forward(self, path, ctx):
        x = self.conv(path.unsqueeze(1))  # (B, 16, 7)
        x = x.flatten(1)
        return self.head(torch.cat([x, ctx], 1)).squeeze(1)


def fit_cnn(train, ycol="y", epochs=15, seed=0):
    torch.manual_seed(seed)
    path_cols = [f"p{i}" for i in range(SPARK_POINTS)]
    ctx_cols = ["t", "h", "is_cur", "shrunk_base", "rel_level_pct"]
    d = train[train[ycol].notna()].reset_index(drop=True)
    P = torch.tensor(d[path_cols].values, dtype=torch.float32, device=DEV)
    ctx_raw = d[ctx_cols].values.astype("float32")
    mu, sd = ctx_raw.mean(0), ctx_raw.std(0) + 1e-6
    C = torch.tensor((ctx_raw - mu) / sd, dtype=torch.float32, device=DEV)
    y = torch.tensor(d[ycol].clip(-CLIP, CLIP).values, dtype=torch.float32, device=DEV)
    model = SparkCNN(n_ctx=len(ctx_cols)).to(DEV)
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-2)
    n, bs = len(y), 8192
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=epochs * (n // bs + 1))
    lossf = nn.HuberLoss(delta=0.5)
    for _ in range(epochs):
        perm = torch.randperm(n, device=DEV)
        model.train()
        for i in range(0, n, bs):
            idx = perm[i : i + bs]
            opt.zero_grad()
            lossf(model(P[idx], C[idx]), y[idx]).backward()
            opt.step()
            sched.step()
    model.eval()

    def predict(test):
        Pt = torch.tensor(test[path_cols].values, dtype=torch.float32, device=DEV)
        Ct = torch.tensor((test[ctx_cols].values.astype("float32") - mu) / sd, dtype=torch.float32, device=DEV)
        with torch.no_grad():
            return model(Pt, Ct).cpu().numpy()

    return predict


def fit_xgb_scalar(train, ycol="y"):
    """The comparison point: XGBoost on the hand-built momentum scalars DERIVED from the same 7-point path
    (mom1/mom3/mom6/vol6/accel/dev_sm3), plus the same t/h/is_cur/shrunk_base/rel_level_pct context."""
    def path_features(df):
        p = df[[f"p{i}" for i in range(SPARK_POINTS)]].values  # p[i] = log(price_i / price_now), i.e. path[6]=0
        mom1, mom3, mom6 = -p[:, 5], -p[:, 3], -p[:, 0]
        diffs = np.diff(p, axis=1)
        vol6 = diffs.std(axis=1)
        accel = mom3 - (mom6 - mom3)
        dev_sm3 = -(p[:, 4:7].mean(axis=1))
        return pd.DataFrame({"mom1": mom1, "mom3": mom3, "mom6": mom6, "vol6": vol6, "accel": accel, "dev_sm3": dev_sm3})

    feat = pd.concat([train[["t", "h", "is_cur", "shrunk_base", "rel_level_pct"]].reset_index(drop=True),
                       path_features(train).reset_index(drop=True)], axis=1)
    cols = list(feat.columns)
    d = feat.assign(**{ycol: train[ycol].values})
    d = d[d[ycol].notna()]
    dm = xgb.DMatrix(d[cols].values.astype("float32"), label=d[ycol].clip(-CLIP, CLIP).values, feature_names=cols)
    params = {"device": os.environ.get("XGB_DEVICE", "cuda"), "tree_method": "hist",
              "objective": "reg:pseudohubererror", "huber_slope": 0.5, "max_depth": 8, "min_child_weight": 200,
              "eta": 0.10, "subsample": 0.8, "colsample_bytree": 0.8, "reg_lambda": 10.0, "seed": 0}
    model = xgb.train(params, dm, num_boost_round=200)

    def predict(test):
        f = pd.concat([test[["t", "h", "is_cur", "shrunk_base", "rel_level_pct"]].reset_index(drop=True),
                        path_features(test).reset_index(drop=True)], axis=1)
        return model.predict(xgb.DMatrix(f[cols].values.astype("float32"), feature_names=cols))

    return predict


def main(holdout="Mirage"):
    parts = sorted(glob.glob(os.path.join(ROWS, f"spark__nested__*__x{holdout}.json")))
    if not parts:
        print(f"No spark__nested__*__x{holdout}.json rows yet - run scripts/export-sparkline-paths.ts first.")
        return
    train = pd.concat([load_spark(os.path.basename(p)[:-5].removeprefix("spark__")) for p in parts], ignore_index=True)
    test = load_spark(f"full__{holdout}")
    test = test[test.y.notna()].reset_index(drop=True)
    print(f"holdout {holdout}: train {len(train):,} rows (complete 7-point paths only), test {len(test):,} rows")
    print(f"torch device: {DEV}")

    xgb_scalar_pred = fit_xgb_scalar(train)(test)
    cnn_preds = [fit_cnn(train, seed=s)(test) for s in (0, 1, 2)]
    cnn_avg = np.mean(cnn_preds, axis=0)

    results = {
        "production (shrunk_base)": score(test, test.shrunk_base.values),
        "XGBoost on momentum SCALARS (derived from path)": score(test, xgb_scalar_pred),
        "1D CNN over RAW path, seed0": score(test, cnn_preds[0]),
        "1D CNN over RAW path, seed1": score(test, cnn_preds[1]),
        "1D CNN over RAW path, seed2": score(test, cnn_preds[2]),
        "1D CNN, 3-seed average": score(test, cnn_avg),
    }
    report(f"{holdout} holdout: scalar-feature XGBoost vs raw-path CNN (chaos)", results)

    for lo, hi, tag in ((0, 25, "EARLY t<=25"), (30, 9999, "LATE t>=30")):
        sub = {k: r[(r.t >= lo) & (r.t <= hi)] for k, r in results.items()}
        print(f"\n--- {tag} ---")
        tab = {k: {"per-scn rho": r.rho.mean(), "top10 hit%": r.hit.mean() * 100} for k, r in sub.items()}
        print(pd.DataFrame(tab).T.round(4).to_string())

    d_scalar = np.abs(xgb_scalar_pred - test.y.values)
    d_cnn = np.abs(cnn_avg - test.y.values)
    print(f"\nmean |error|: scalar-XGB {d_scalar.mean():.4f}   CNN (3-seed avg) {d_cnn.mean():.4f}")
    print("CONCLUSION:", "CNN over the raw path beats the hand-built scalars" if results["1D CNN, 3-seed average"].rho.mean() >
          results["XGBoost on momentum SCALARS (derived from path)"].rho.mean() + 0.01 else
          "scalars already capture the usable signal in the 7-point path - CNN adds no meaningful gain")


if __name__ == "__main__":
    main()
