"""Fits the production predictor on rows exported by scripts/export-training-features.ts (features computed by the
app's own TypeScript code) and writes lib/models/predictor.json.

  1. VALIDATION - for each holdout league H that has nested rows: train on the other leagues' nested rows (H excluded
     from their features and labels), test on the full__H rows; report production vs formula vs XGBoost by league
     day bucket and kind (per-scenario Spearman, top-10% hit rate).
  2. FINAL       - train on every full__* league (each featurised from the other leagues) and export
     lib/models/predictor.json (formula tables + 200-tree XGBoost per denomination, chaos and divine).
  3. HOLDOUT EXPORT - the holdout-H models as ml/cache/tsrows/model_holdout_H.json + predictions on the test rows,
     so scripts/check-predictor-parity.ts can prove the TypeScript runtime reproduces Python's numbers.

    python fit_production.py [validate|final|variants|all]   (default all)
"""
import base64
import glob
import json
import os
import sys
import time
import warnings

import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.stats import spearmanr
from sklearn.linear_model import Ridge

warnings.filterwarnings("ignore")
HERE = os.path.dirname(__file__)
ROWS = os.path.join(HERE, "cache", "tsrows")
MODEL_OUT = os.path.join(HERE, "..", "lib", "models", "predictor.json")
CLIP = 2.5

FEATURES = ["t", "h", "is_cur", "n_ref", "ref_mean", "ref_std", "ref_up", "peer_ref_mean", "shrunk_base", "x_now",
            "rel_level", "rel_level_pct", "rel_level_w", "mom1", "mom3", "mom6", "vol6", "accel", "dev_sm3", "mom6_pct",
            "peer_mom6", "n_ref_div", "refd_mean", "refd_std", "refd_up", "peer_refd_mean", "shrunk_div", "x_now_div",
            "rel_level_div"]
# What the models read. Chosen for how they behave on a LIVE league, not just in validation (see ml/README.md,
# "Training vs serving drift"): no raw chaos price level (x_now) - the price in divines is the tier feature, since a
# league's chaos prices shift as a whole with chaos debasement; no n_ref - past leagues at late days number 3 in
# training but 4 live. rel_level* are already demeaned across the market by lib/prediction-features.ts.
CHAOS_COLS = ["t", "h", "is_cur", "ref_mean", "ref_std", "ref_up", "peer_ref_mean", "shrunk_base", "x_now_div",
              "rel_level", "rel_level_pct", "rel_level_w", "mom1", "mom3", "mom6", "vol6", "accel", "dev_sm3", "mom6_pct",
              "peer_mom6"]
DIVINE_EXTRA = ["refd_mean", "refd_std", "refd_up", "peer_refd_mean", "shrunk_div", "rel_level_div"]
XGB_COLS = {"chaos": CHAOS_COLS, "divine": CHAOS_COLS + DIVINE_EXTRA}
# poe.ninja returns no sparkline for ~30% of live items (illiquid ones) and nulls elsewhere - ~48% of live items have
# no usable momentum vs 0.3% in the historical rows. Training rows lose all momentum at the same rate so the model
# (and formula) learns what to do without it instead of guessing a default branch it never saw.
MOM_MASK = ["mom1", "mom3", "mom6", "vol6", "accel", "dev_sm3", "mom6_pct"]
MASK_RATE = 0.45
XGB_PARAMS = {"device": os.environ.get("XGB_DEVICE", "cuda"),  # XGB_DEVICE=cpu without an NVIDIA GPU
               "tree_method": "hist", "objective": "reg:pseudohubererror", "huber_slope": 0.5,
              "max_depth": 8, "min_child_weight": 200, "eta": 0.10, "subsample": 0.8, "colsample_bytree": 0.8,
              "reg_lambda": 10.0, "seed": 0}
ROUNDS = 200
# league-day buckets for the formula; each has its own coefficients per kind
BUCKETS = [(0, 0), (1, 5), (6, 29), (30, 59), (60, 9999)]
MOM_LATE = ["mom1", "mom3", "mom6", "mom6_pct", "accel", "vol6", "dev_sm3", "peer_mom6"]


def tradeable(df):
    """Items priced under 1c are price-tick noise, not flips (the original model applies the same 1c floor to
    reference prices, growth-ratios.ts MIN_STARTING_VALUE_ITEM): train and score on currency + items >= 1c only.
    lib/prediction-model.ts serves the production ratio for a sub-1c item instead of a forecast."""
    return df[(df.is_cur == 1) | (df.x_now >= 0)].reset_index(drop=True)


def augment(df, seed=0, rate=MASK_RATE):
    """Randomly drop ALL momentum from a share of rows (all-or-nothing, like a missing sparkline)."""
    rng = np.random.default_rng(seed)
    m = rng.random(len(df)) < rate
    out = df.copy()
    for c in MOM_MASK:
        out.loc[m, c] = np.nan
    return out


def load(label):
    meta = json.load(open(os.path.join(ROWS, f"{label}.json")))
    a = np.fromfile(os.path.join(ROWS, f"{label}.f32"), dtype=np.float32).reshape(-1, len(meta["columns"]))
    return pd.DataFrame(a, columns=meta["columns"])


def formula_cols(denom, lo):
    base = ["shrunk_div" if denom == "divine" else "shrunk_base", "rel_level_pct", "rel_level_w"]
    if lo == 0:
        return base
    if lo <= 5:
        return base + ["mom1", "mom3", "dev_sm3"]
    return base + MOM_LATE


def fit_formula(df, denom):
    ycol = "yd" if denom == "divine" else "y"
    out = []
    for lo, hi in BUCKETS:
        for kind, is_cur in (("currency", 1), ("item", 0)):
            d = df[(df.t >= lo) & (df.t <= hi) & (df.is_cur == is_cur) & df[ycol].notna()]
            cols = formula_cols(denom, lo)
            d = d[d[cols[0]].notna()]
            if len(d) < 200:
                continue
            X = d[cols].values.astype("float64")
            mu, sd = np.nanmean(X, 0), np.nanstd(X, 0) + 1e-6
            Z = np.clip(np.nan_to_num((X - mu) / sd), -6, 6)
            m = Ridge(alpha=10.0).fit(Z, d[ycol].clip(-CLIP, CLIP).values)
            out.append({"kind": kind, "tMin": lo, "tMax": hi, "cols": cols, "mu": [float(v) for v in mu],
                        "sd": [float(v) for v in sd], "coef": [float(v) for v in m.coef_], "intercept": float(m.intercept_)})
    return out


def apply_formula(buckets, df):
    pred = np.full(len(df), np.nan)
    for b in buckets:
        m = ((df.t >= b["tMin"]) & (df.t <= b["tMax"]) & (df.is_cur == (1 if b["kind"] == "currency" else 0))).values
        if not m.any():
            continue
        Z = np.clip(np.nan_to_num((df.loc[m, b["cols"]].values.astype("float64") - b["mu"]) / b["sd"]), -6, 6)
        pred[m] = b["intercept"] + Z @ np.array(b["coef"])
    # rows beyond the last bucket use the latest bucket of their kind (mirrors lib/prediction-model.ts)
    return pred


def fit_xgb(df, denom):
    ycol = "yd" if denom == "divine" else "y"
    d = df[df[ycol].notna()]
    cols = XGB_COLS[denom]
    dm = xgb.DMatrix(d[cols].values.astype("float32"), label=d[ycol].clip(-CLIP, CLIP).values, feature_names=cols)
    return xgb.train(XGB_PARAMS, dm, num_boost_round=ROUNDS), cols


def xgb_predict(m, cols, df):
    return m.predict(xgb.DMatrix(df[cols].values.astype("float32"), feature_names=cols))


def pack(booster, cols):
    cfg = json.loads(booster.save_config())
    base = float(str(cfg["learner"]["learner_model_param"]["base_score"]).strip("[]"))
    trees = json.loads(booster.save_raw("json"))["learner"]["gradient_booster"]["model"]["trees"]
    F, C, L, R, D, roots = [], [], [], [], [], []
    for t in trees:
        off = len(F)
        roots.append(off)
        for i in range(len(t["split_indices"])):
            leaf = t["left_children"][i] == -1
            F.append(-1 if leaf else t["split_indices"][i])
            C.append(t["base_weights"][i] if leaf else t["split_conditions"][i])
            L.append(-1 if leaf else t["left_children"][i] + off)
            R.append(-1 if leaf else t["right_children"][i] + off)
            D.append(1 if t["default_left"][i] else 0)
    b64 = lambda a, dt: base64.b64encode(np.asarray(a, dtype=dt).tobytes()).decode()
    return {"baseScore": base, "cols": cols, "roots": b64(roots, "<i4"), "f": b64(F, "<i2"), "c": b64(C, "<f4"),
            "l": b64(L, "<i4"), "r": b64(R, "<i4"), "d": b64(D, "u1")}


def model_json(train, note):
    """Returns (packed model JSON, {denomination: (booster, columns)}) - the boosters are kept for validation reports."""
    mj = {"version": 1, "trainedOn": note, "clip": CLIP,
          "formula": {"chaos": fit_formula(train, "chaos"), "divine": fit_formula(train, "divine")}, "xgb": {}}
    boosters = {}
    for d in ("chaos", "divine"):
        b, cols = fit_xgb(train, d)
        mj["xgb"][d] = pack(b, cols)
        boosters[d] = (b, cols)
    return mj, boosters


def variants(holdout="Mirage"):
    """Which momentum / helper features earn their place? Chaos XGBoost on the holdout, clean and with live-like
    missingness at test time (45% of rows without momentum)."""
    parts = sorted(glob.glob(os.path.join(ROWS, f"nested__*__x{holdout}.json")))
    train = augment(tradeable(pd.concat([load(os.path.basename(p)[:-5]) for p in parts], ignore_index=True)))
    test = tradeable(load(f"full__{holdout}"))
    test = test[test.y.notna()].reset_index(drop=True)
    masked = augment(test, seed=1)
    sets = {
        "shipped": CHAOS_COLS,
        "no vol6": [c for c in CHAOS_COLS if c != "vol6"],
        "no vol6, dev_sm3": [c for c in CHAOS_COLS if c not in ("vol6", "dev_sm3")],
        "no vol6, dev_sm3, mom1": [c for c in CHAOS_COLS if c not in ("vol6", "dev_sm3", "mom1")],
        "no momentum at all": [c for c in CHAOS_COLS if c not in MOM_MASK + ["peer_mom6"]],
        "shipped + n_ref": CHAOS_COLS + ["n_ref"],
        "shipped + raw x_now": CHAOS_COLS + ["x_now"],
    }
    preds_clean, preds_masked = {"production": test.shrunk_base.values}, {"production": masked.shrunk_base.values}
    for name, cols in sets.items():
        dm = xgb.DMatrix(train[cols].values.astype("float32"), label=train.y.clip(-CLIP, CLIP).values, feature_names=cols)
        b = xgb.train(XGB_PARAMS, dm, num_boost_round=ROUNDS)
        preds_clean[name] = b.predict(xgb.DMatrix(test[cols].values.astype("float32"), feature_names=cols))
        preds_masked[name] = b.predict(xgb.DMatrix(masked[cols].values.astype("float32"), feature_names=cols))
    report(f"{holdout} holdout, chaos, CLEAN test", test, preds_clean, "y")
    report(f"{holdout} holdout, chaos, 45% of test rows WITHOUT momentum (live-like)", masked, preds_masked, "y")


# ------------------------------------------------------------------------------------------------ validation
def bucket_name(t):
    return np.select([t == 0, t <= 5, t <= 29, t <= 59], ["t=0", "t=1-5", "t=6-29", "t=30-59"], "t=60+")


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
    r["b"] = bucket_name(r.t.values)
    return r


def report(name, test, preds, ycol):
    tab = {}
    for k, p in preds.items():
        r = score(test, p, ycol)
        row = {"ALL rho": r.rho.mean(), "ALL hit%": r.hit.mean() * 100, "ALL top10": r.top10.mean()}
        for b, g in r.groupby("b"):
            row[f"{b} rho"] = g.rho.mean()
        rc = r[r.cur == 1]
        row["cur rho"], row["cur top10"] = rc.rho.mean(), rc.top10.mean()
        tab[k] = row
    pd.set_option("display.width", 250)
    print(f"\n=== {name} ===")
    print(pd.DataFrame(tab).T.round(3).to_string())


def validate(holdouts):
    for h in holdouts:
        parts = sorted(glob.glob(os.path.join(ROWS, f"nested__*__x{h}.json")))
        if not parts or not os.path.exists(os.path.join(ROWS, f"full__{h}.json")):
            print(f"skip {h}: rows missing")
            continue
        t0 = time.time()
        train = augment(tradeable(pd.concat([load(os.path.basename(p)[:-5]) for p in parts], ignore_index=True)))
        test = tradeable(load(f"full__{h}"))
        print(f"\nholdout {h}: train {len(train):,} rows ({len(parts)} leagues), test {len(test):,} rows")
        mj, rt = model_json(train, f"validation model, holdout {h}")
        json.dump(mj, open(os.path.join(ROWS, f"model_holdout_{h}.json"), "w"), separators=(",", ":"))
        for denom, ycol, base in (("chaos", "y", "shrunk_base"), ("divine", "yd", "shrunk_div")):
            te = test[test[ycol].notna() & test[base].notna()].reset_index(drop=True)
            preds = {"production": te[base].values, "formula": apply_formula(mj["formula"][denom], te),
                     "xgb (200 trees)": xgb_predict(*rt[denom], te)}
            report(f"{h} holdout, {denom}-denominated ({len(te):,} rows)", te, preds, ycol)
            for lo, hi, tag in ((0, 25, "EARLY t<=25"), (30, 9999, "LATE t>=30")):
                m = ((te.t >= lo) & (te.t <= hi)).values
                sub = te[m].reset_index(drop=True)
                report(f"{h} holdout, {denom}, {tag}", sub, {k: v[m] for k, v in preds.items()}, ycol)
        # predictions for the TS parity check (chaos xgb + formula on the first 20k test rows of a few scenarios)
        chk = test[test.t.isin([1, 14, 60]) & test.h.isin([3, 14])].reset_index(drop=True)
        np.asarray(chk[FEATURES + ["y", "yd"]].values, dtype="<f4").tofile(os.path.join(ROWS, f"parity_{h}.f32"))
        json.dump({"rows": len(chk), "columns": FEATURES + ["y", "yd"],
                   "xgb_chaos": [None if not np.isfinite(v) else float(v) for v in xgb_predict(*rt["chaos"], chk)],
                   "xgb_divine": [None if not np.isfinite(v) else float(v) for v in xgb_predict(*rt["divine"], chk)],
                   "formula_chaos": [None if not np.isfinite(v) else float(v) for v in apply_formula(mj["formula"]["chaos"], chk)]},
                  open(os.path.join(ROWS, f"parity_{h}.json"), "w"))
        print(f"({time.time()-t0:.0f}s)")


def final():
    labels = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(ROWS, "full__*.json")))
    train = augment(tradeable(pd.concat([load(l) for l in labels], ignore_index=True)))
    print(f"final model: {len(train):,} rows from {labels}")
    mj, _ = model_json(train, "trained on " + ", ".join(l.replace("full__", "") for l in labels) +
                       " (each league featurised from the other four)")
    json.dump(mj, open(MODEL_OUT, "w"), separators=(",", ":"))
    print(f"wrote {MODEL_OUT} ({os.path.getsize(MODEL_OUT)/1e6:.2f} MB)")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    holds = sorted({os.path.basename(p).split("__x")[1][:-5] for p in glob.glob(os.path.join(ROWS, "nested__*__x*.json"))})
    if cmd == "variants":
        variants(holds[0] if holds else "Mirage")
    if cmd in ("validate", "all"):
        validate(holds)
    if cmd in ("final", "all"):
        final()
