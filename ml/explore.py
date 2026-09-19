"""Round-2 exploration for EARLY-league prediction: momentum, analog forecasting, piecewise formulas, XGBoost
targets/objectives (regression, rank-target, learning-to-rank), on the same leave-one-league-out protocol and the
same production rows as run_experiment.py. Fold datasets come from build_folds.py.

    python explore.py run  [name ...]     # fit models for every holdout, cache predictions (skips cached)
    python explore.py report [name ...]   # score cached predictions (all cached if no names)

Feature groups (features.py):
    BASE   the 30 original features            LIVE   BASE + MOM (poe.ninja's 7-day sparkline) + ANALOG
    ORACLE LIVE + HIST (needs a daily price log for the live league, which the app does not have today)
"""
from __future__ import annotations

import os
import pickle
import sys
import time
import warnings

import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.stats import norm, spearmanr

warnings.filterwarnings("ignore")
import run_experiment as rx
from features import ANALOG_COLS, FEATURE_COLS, HIST_COLS, KIND_COLS, LEAGUES, MOM_COLS, SMOOTH_COLS

FOLDS = os.path.join(rx.CACHE, "folds")
PRED_PATH = os.path.join(rx.CACHE, "preds_explore.pkl")
N_CAT = int(pd.read_json(os.path.join(FOLDS, "meta.json"), typ="series")["n_cat"]) if os.path.exists(os.path.join(FOLDS, "meta.json")) else 0
GROUP = ["target", "kind", "t", "h"]

BASE = FEATURE_COLS
BASE_MOM = BASE + MOM_COLS
BASE_ANALOG = BASE + ANALOG_COLS
LIVE = BASE + MOM_COLS + ANALOG_COLS
LIVE2 = LIVE + SMOOTH_COLS + KIND_COLS
ORACLE = LIVE + HIST_COLS
# league-level constants: identical for every item in a scenario, so with only 4 training leagues they let a
# model memorise which league it is looking at instead of learning item-level behaviour
MACRO = ["div_now", "macro_div_rel", "ref_div_drift", "div_mom6", "rel_div_mom6", "mkt_mom6", "ref_pre_mean"]
# hand-picked set a TypeScript port could realistically build from what the app already fetches: cross-league
# aggregates it already computes, one extra aggregate (mean past price at day t), poe.ninja's 7-day sparkline, live price
PORT = ["t", "h", "is_cur", "n_ref", "ref_mean", "ref_std", "ref_up", "shrunk_base", "peer_ref_mean", "x_now",
        "rel_level", "rel_level_pct", "rel_level_w", "mom1", "mom3", "mom6", "vol6", "accel", "dev_sm3",
        "mom6_pct", "peer_mom6"]
HUBER = {"objective": "reg:pseudohubererror", "huber_slope": 0.5}
D8 = {"max_depth": 8, "min_child_weight": 200}


# ============================================================================================ helpers
def to_X(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    X = df[cols].copy()
    if "cat" in cols:
        X["cat"] = pd.Categorical(X["cat"], categories=list(range(N_CAT)))
    return X.astype({c: "float32" for c in cols if c != "cat"})


XGB_BASE = {"device": "cuda", "tree_method": "hist", "max_depth": 6, "eta": 0.05, "subsample": 0.8,
            "colsample_bytree": 0.8, "min_child_weight": 100, "reg_lambda": 10.0, "max_cat_to_onehot": 1, "seed": 0}


def fit_xgb(train, cols, params, rounds, label=None, qid=None, weight=None, base_margin=None):
    y = train.y.clip(-rx.Y_CLIP, rx.Y_CLIP).values if label is None else label
    d = xgb.DMatrix(to_X(train, cols), label=y, enable_categorical=True, qid=qid, weight=weight, base_margin=base_margin)
    m = xgb.train({**XGB_BASE, **params}, d, num_boost_round=rounds)
    return (lambda te, bm=None: m.predict(xgb.DMatrix(to_X(te, cols), enable_categorical=True, base_margin=bm))), m


def xgb_model(cols, params=None, rounds=400, seed=0, target="y", cur_weight=None):
    """target: y | rank (within-scenario normal scores) | demean (minus scenario median).
    cur_weight: up-weight currency rows (they are ~1% of training rows but the flips people care about most)."""
    def f(tr, te):
        p = {**HUBER, **(params or {}), "seed": seed}
        label = None
        w = np.where(tr.kind.values == "currency", cur_weight, 1.0).astype("float32") if cur_weight else None
        if w is not None:
            return fit_xgb(tr, cols, p, rounds, weight=w)[0](te)
        if target == "rank":
            r = tr.groupby(GROUP)["y"].rank(pct=True)
            n = tr.groupby(GROUP)["y"].transform("count")
            label = np.asarray(norm.ppf(((r * n - 0.5) / n).values), dtype="float32")
            p = {**XGB_BASE, "objective": "reg:squarederror", **(params or {}), "seed": seed}
        elif target == "demean":
            label = (tr.y - tr.groupby(GROUP)["y"].transform("median")).clip(-rx.Y_CLIP, rx.Y_CLIP).values
        return fit_xgb(tr, cols, p, rounds, label=label)[0](te)
    return f


def ltr_model(cols, objective, grades=10, rounds=300, extra=None):
    def f(tr, te):
        tr = tr.sort_values(GROUP).reset_index(drop=True)
        grp = tr.groupby(GROUP, sort=False).ngroup().values
        pct = tr.groupby(GROUP)["y"].rank(pct=True, method="first").values
        label = np.minimum((pct * grades).astype(int), grades - 1).astype("float32")
        p = {"objective": objective, **(extra or {})}
        return fit_xgb(tr, cols, p, rounds, label=label, qid=grp)[0](te)
    return f


def kind_split(cols_cur, params_cur, rounds_cur, cols_item, params_item, rounds_item):
    """Separate models per kind: the currency market (~150 names, hyper-inflating early) behaves nothing like
    12k item rows/scenario, and a joint model is dominated by items."""
    def f(tr, te):
        pred = np.zeros(len(te), dtype="float32")
        for kind, cols, params, rounds in (("currency", cols_cur, params_cur, rounds_cur),
                                           ("item", cols_item, params_item, rounds_item)):
            mtr, mte = (tr.kind == kind).values, (te.kind == kind).values
            pred[mte] = fit_xgb(tr[mtr], cols, {**HUBER, **params}, rounds)[0](te[mte])
        return pred
    return f


def mlp_model(cols, epochs=8, seed=0, width=256):
    """GPU MLP with a category embedding and missing-value indicators (same recipe as models_compare.py)."""
    def f(tr, te):
        import torch
        import torch.nn as nn
        dev = torch.device("cuda")
        num = [c for c in cols if c != "cat"]
        X = tr[num].astype("float32").values
        mu, sd = np.nanmean(X, 0), np.nanstd(X, 0) + 1e-6
        has_nan = np.isnan(X).any(0)

        def design(d):
            A = d[num].astype("float32").values
            miss = np.isnan(A)
            return np.hstack([np.clip(np.where(miss, 0.0, (A - mu) / sd), -6, 6), miss[:, has_nan]]).astype("float32")

        torch.manual_seed(seed)
        Xtr = torch.tensor(design(tr), device=dev)
        ctr = torch.tensor(tr.cat.values.astype("int64"), device=dev)
        ytr = torch.tensor(tr.y.clip(-rx.Y_CLIP, rx.Y_CLIP).values.astype("float32"), device=dev)

        class Net(nn.Module):
            def __init__(self, d_in):
                super().__init__()
                self.emb = nn.Embedding(N_CAT, 8)
                self.net = nn.Sequential(nn.Linear(d_in + 8, width), nn.GELU(), nn.Dropout(0.1),
                                         nn.Linear(width, width), nn.GELU(), nn.Dropout(0.1),
                                         nn.Linear(width, width // 2), nn.GELU(), nn.Linear(width // 2, 1))

            def forward(self, x, c):
                return self.net(torch.cat([x, self.emb(c)], 1)).squeeze(1)

        net = Net(Xtr.shape[1]).to(dev)
        opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-2)
        n, bs = len(ytr), 8192
        sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=epochs * (n // bs + 1))
        lossf = nn.HuberLoss(delta=0.5)
        for _ in range(epochs):
            perm = torch.randperm(n, device=dev)
            net.train()
            for i in range(0, n, bs):
                ix = perm[i : i + bs]
                opt.zero_grad()
                lossf(net(Xtr[ix], ctr[ix]), ytr[ix]).backward()
                opt.step()
                sched.step()
        net.eval()
        with torch.no_grad():
            return net(torch.tensor(design(te), device=dev), torch.tensor(te.cat.values.astype("int64"), device=dev)).cpu().numpy()

    return f


def xgb_topk(cols, k, params=None, rounds=400, drop_cat=False):
    """Portability probe: rank features by gain on THIS fold's training rows only, keep the top k, refit."""
    def f(tr, te):
        c = [x for x in cols if not (drop_cat and x == "cat")]
        p = {**HUBER, **D8, **(params or {})}
        _, m = fit_xgb(tr, c, p, 200)
        imp = m.get_score(importance_type="gain")
        top = [x for x in sorted(imp, key=imp.get, reverse=True)][:k]
        return fit_xgb(tr, top, p, rounds)[0](te)
    return f


def hybrid(cols_for_bucket, xgb_cols, params=None, rounds=250, by_kind=True):
    """Piecewise formula (per day-bucket x kind) gives the base prediction; trees only learn its residual.
    Ports as: the formula + a (much smaller) set of trees."""
    from sklearn.linear_model import Ridge

    def f(tr, te):
        base_tr, base_te = np.zeros(len(tr), dtype="float32"), np.zeros(len(te), dtype="float32")
        for lo, hi in BUCKETS:
            for k in (["currency", "item"] if by_kind else [None]):
                mtr = (tr.t.between(lo, hi) & ((tr.kind == k) if k else True)).values
                mte = (te.t.between(lo, hi) & ((te.kind == k) if k else True)).values
                cols = cols_for_bucket(lo)
                st = _standardize(tr[mtr], cols)
                m = Ridge(alpha=10.0).fit(st(tr[mtr]), tr.y[mtr].clip(-rx.Y_CLIP, rx.Y_CLIP).values)
                base_tr[mtr] = m.predict(st(tr[mtr]))
                if mte.any():
                    base_te[mte] = m.predict(st(te[mte]))
        p = {**HUBER, "max_depth": 6, "min_child_weight": 100, **(params or {})}
        return fit_xgb(tr, xgb_cols, p, rounds, base_margin=base_tr)[0](te, base_te)
    return f


def _standardize(train, cols):
    X = train[cols].astype("float32").values
    mu, sd = np.nanmean(X, 0), np.nanstd(X, 0) + 1e-6
    return lambda d: np.clip(np.nan_to_num((d[cols].astype("float32").values - mu) / sd), -6, 6)


def ridge(train, test, cols, alpha=10.0):
    from sklearn.linear_model import Ridge
    f = _standardize(train, cols)
    m = Ridge(alpha=alpha).fit(f(train), train.y.clip(-rx.Y_CLIP, rx.Y_CLIP).values)
    return m.predict(f(test))


BUCKETS = [(0, 0), (2, 4), (7, 10), (14, 25)]  # league-day buckets: start / first days / first week+ / mid-early


def piecewise(cols_for_bucket, by_kind=False):
    """A 'formula' with its own coefficients per league-day bucket (and optionally per kind) - still a lookup
    table of a few numbers per bucket, portable to TypeScript."""
    def f(tr, te):
        pred = np.zeros(len(te))
        kinds = [("currency",), ("item",)] if by_kind else [(None,)]
        for lo, hi in BUCKETS:
            for (k,) in kinds:
                mtr = tr.t.between(lo, hi) & ((tr.kind == k) if k else True)
                mte = (te.t.between(lo, hi) & ((te.kind == k) if k else True)).values
                if mte.any():
                    pred[mte] = ridge(tr[mtr], te[mte], cols_for_bucket(lo))
        return pred
    return f


F0 = ["shrunk_base", "rel_level_pct"]
F1 = F0 + ["rel_level_w"]


def cols_mom(lo):
    if lo == 0:
        return F1
    if lo <= 4:
        return F1 + ["mom1", "mom3"]
    return F1 + ["mom1", "mom3", "mom6_pct", "rel_mom6_pct", "accel", "rel_mom6"]


def cols_mom_analog(lo):
    return cols_mom(lo) + ["analog_mom", "analog_lvl"]


def cols_sm_mom(lo):
    """Smoothed base ratio + smoothed level rank + RAW momentum (currency continues, items revert; the per-kind
    fit learns the sign). No cross-league-relative momentum: it is uncorrelated with returns (see trend_analysis.py)."""
    base = ["shrunk_sm", "rel_level_sm_pct", "rel_level_w"]
    if lo == 0:
        return base
    if lo <= 4:
        return base + ["mom1", "mom3", "dev_sm3"]
    return base + ["mom1", "mom3", "mom6", "dev_sm3", "accel", "vol6", "peer_mom6"]


MODELS = {
    # ---- reference points
    "production": lambda tr, te: te.log_pred.values,
    "formula F0 (shrunk+level pct)": lambda tr, te: ridge(tr, te, F0),
    "formula F1 (+level raw)": lambda tr, te: ridge(tr, te, F1),
    # ---- formulas that add momentum / analogs / per-day coefficients
    "formula F0 + mom6 pct": lambda tr, te: ridge(tr, te, F0 + ["mom6_pct", "rel_mom6_pct"]),
    "formula piecewise-t F1": piecewise(lambda lo: F1),
    "formula piecewise-t F1+mom": piecewise(cols_mom),
    "formula piecewise-t F1+mom+analog": piecewise(cols_mom_analog),
    "formula piecewise-t+kind F1+mom": piecewise(cols_mom, by_kind=True),
    # ---- XGBoost by feature group
    "xgb BASE": xgb_model(BASE),
    "xgb BASE+MOM": xgb_model(BASE_MOM),
    "xgb BASE+ANALOG": xgb_model(BASE_ANALOG),
    "xgb LIVE (mom+analog)": xgb_model(LIVE),
    "xgb ORACLE (+own history)": xgb_model(ORACLE),
    # ---- targets / objectives on the live-feasible set
    "xgb LIVE rank-target": xgb_model(LIVE, target="rank"),
    "xgb LIVE demeaned-target": xgb_model(LIVE, target="demean"),
    "xgb LIVE LTR pairwise": ltr_model(LIVE, "rank:pairwise"),
    "xgb LIVE LTR ndcg": ltr_model(LIVE, "rank:ndcg", extra={"ndcg_exp_gain": False}),
    # ---- capacity / variance
    "xgb LIVE depth4": xgb_model(LIVE, {"max_depth": 4}, rounds=500),
    "xgb LIVE depth8": xgb_model(LIVE, {"max_depth": 8, "min_child_weight": 200}, rounds=400),
    "xgb LIVE seed1": xgb_model(LIVE, seed=1),
    "xgb LIVE seed2": xgb_model(LIVE, seed=2),
    # ---- round 3: denoising features, currency focus
    "formula F_sm (shrunk_sm+level_sm pct)": lambda tr, te: ridge(tr, te, ["shrunk_sm", "rel_level_sm_pct"]),
    "formula F0+sm": lambda tr, te: ridge(tr, te, F0 + ["shrunk_sm", "rel_level_sm_pct", "dev_sm3"]),
    "formula piecewise-t+kind F1+mom+sm": piecewise(lambda lo: cols_mom(lo) + ["shrunk_sm", "rel_level_sm_pct", "dev_sm3"], by_kind=True),
    "xgb LIVE2 (+smooth,+is_cur)": xgb_model(LIVE2),
    "xgb LIVE2 cur-weight 10": xgb_model(LIVE2, cur_weight=10),
    "xgb LIVE2 cur-weight 40": xgb_model(LIVE2, cur_weight=40),
    "xgb LIVE2 per-kind": kind_split(LIVE2, {"max_depth": 4, "min_child_weight": 20, "eta": 0.03}, 300,
                                     LIVE2, {}, 400),
    "xgb LIVE2 per-kind shallow-cur": kind_split(LIVE2, {"max_depth": 3, "min_child_weight": 50, "eta": 0.03}, 300,
                                                 LIVE2, {}, 400),
    # ---- round 4: capacity on the full live-feasible set + a GPU net for ensemble diversity
    "xgb LIVE2 depth8": xgb_model(LIVE2, D8),
    "xgb LIVE2 depth8 cur-weight 10": xgb_model(LIVE2, D8, cur_weight=10),
    "xgb LIVE2 depth10": xgb_model(LIVE2, {"max_depth": 10, "min_child_weight": 300}),
    "xgb LIVE2 depth8 mcw50": xgb_model(LIVE2, {"max_depth": 8, "min_child_weight": 50}),
    "xgb LIVE2 depth8 800r eta.03": xgb_model(LIVE2, {**D8, "eta": 0.03}, rounds=800),
    "xgb LIVE2 depth8 seed1": xgb_model(LIVE2, D8, seed=1),
    "xgb LIVE2 depth8 seed2": xgb_model(LIVE2, D8, seed=2),
    "MLP LIVE2 (GPU)": mlp_model(LIVE2),
    # ---- round 5: formulas that use RAW momentum (currency trends continue, items revert) + smoothed inputs
    # ---- round 6: portability probes (fewer features / no categorical / formula + residual trees)
    "xgb LIVE2 d8 no-cat": xgb_model([c for c in LIVE2 if c != "cat"], D8),
    "xgb LIVE2 d8 top8": xgb_topk(LIVE2, 8),
    "xgb LIVE2 d8 top12": xgb_topk(LIVE2, 12),
    "xgb LIVE2 d8 top16": xgb_topk(LIVE2, 16),
    "xgb LIVE2 d8 top24": xgb_topk(LIVE2, 24),
    "hybrid formula + residual trees": hybrid(cols_mom, LIVE2),
    "hybrid formula + small residual trees": hybrid(cols_mom, LIVE2, {"max_depth": 4, "min_child_weight": 300}, rounds=120),
    "xgb LIVE2 d8 no-cat no-macro": xgb_model([c for c in LIVE2 if c != "cat" and c not in MACRO], D8),
    "xgb PORT d8": xgb_model(PORT, D8),
    "xgb PORT d6 300r": xgb_model(PORT, {"max_depth": 6, "min_child_weight": 100}, rounds=300),
    "xgb PORT d8 no-macro-free +ref_min/max": xgb_model(PORT + ["ref_min", "ref_max", "nd_ref"], D8),
    "xgb PORT d8 200r eta.1": xgb_model(PORT, {**D8, "eta": 0.10}, rounds=200),
    "xgb PORT d8 100r eta.2": xgb_model(PORT, {**D8, "eta": 0.20}, rounds=100),
    "xgb PORT d10 150r eta.1": xgb_model(PORT, {"max_depth": 10, "min_child_weight": 300, "eta": 0.10}, rounds=150),
    "formula pw-t+kind sm+rawmom": piecewise(lambda lo: cols_sm_mom(lo), by_kind=True),
    "formula pw-t+kind sm+rawmom+analog": piecewise(lambda lo: cols_sm_mom(lo) + ["analog_mom", "analog_lvl"], by_kind=True),
}

# ensembles built from cached predictions: "avg" keeps calibration (mean of raw log-returns); "blend" is a
# per-scenario rank average (ranking only - scores lose their scale)
DERIVED = {
    "avg xgb LIVE2 d8 x3 seeds": ("avg", ["xgb LIVE2 depth8", "xgb LIVE2 depth8 seed1", "xgb LIVE2 depth8 seed2"]),
    "avg xgb d8 x3 + MLP": ("avg", ["xgb LIVE2 depth8", "xgb LIVE2 depth8 seed1", "xgb LIVE2 depth8 seed2", "MLP LIVE2 (GPU)"]),
    "blend xgb d8 + formula pw-kind": ("blend", ["xgb LIVE2 depth8", "formula pw-t+kind sm+rawmom"]),
    "blend xgb d8 + MLP + formula": ("blend", ["xgb LIVE2 depth8", "MLP LIVE2 (GPU)", "formula pw-t+kind sm+rawmom"]),
}


# ============================================================================================ run
def load_preds():
    return pickle.load(open(PRED_PATH, "rb")) if os.path.exists(PRED_PATH) else {}


def run(names):
    preds = load_preds()
    todo = [n for n in (names or MODELS) if n not in preds or any(h not in preds[n] for h in LEAGUES)]
    print(f"to run: {len(todo)} models")
    t0 = time.time()
    for h in LEAGUES:
        tr = pd.read_parquet(os.path.join(FOLDS, f"{h}_train.parquet"))
        te = pd.read_parquet(os.path.join(FOLDS, f"{h}_test.parquet"))
        print(f"\n--- holdout {h}: train {len(tr):,} test {len(te):,} ({time.time()-t0:.0f}s)", flush=True)
        for n in todo:
            tt = time.time()
            try:
                preds.setdefault(n, {})[h] = np.asarray(MODELS[n](tr, te), dtype="float32")
                print(f"  {n:38s} {time.time()-tt:5.1f}s", flush=True)
            except Exception as e:  # keep going; report at the end
                print(f"  {n:38s} FAILED: {type(e).__name__}: {str(e)[:200]}", flush=True)
        pickle.dump(preds, open(PRED_PATH, "wb"))
        del tr, te
    print(f"\nrun done in {time.time()-t0:.0f}s")


# ============================================================================================ report
RANK_ONLY = ("rank-target", "demeaned", "LTR", "blend")  # scores, not log-returns: skip direction/MAE


def group_stats(d: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for (ho, k, t, h), g in d.groupby(["holdout", "kind", "t", "h"], sort=False):
        if len(g) < 20:
            continue
        y = g.y.values[np.argsort(-g.pred.values, kind="stable")]
        n10, n25 = max(5, int(len(g) * 0.10)), min(25, len(g))
        rows.append((ho, k, t, h, len(g), spearmanr(g.pred, g.y)[0], y[:n10].mean(), (y[:n10] > 0).mean(),
                     (np.exp(np.minimum(y[:n10], np.log(11))) - 1).mean(), y[:n25].mean()))
    return pd.DataFrame(rows, columns=["holdout", "kind", "t", "h", "n", "rho", "top10", "hit", "arith", "top25"])


def tbucket(t):
    return np.select([t == 0, t <= 4, t <= 10], ["t=0", "t=2-4", "t=7-10"], "t=14-25")


def report(names):
    preds = load_preds()
    have = lambda n: n in preds and all(h in preds[n] for h in LEAGUES)
    names = [n for n in (names or (list(MODELS) + list(DERIVED))) if have(n) or n in DERIVED]
    df = pd.concat([pd.read_parquet(os.path.join(FOLDS, f"{h}_test.parquet"), columns=["y", "kind", "t", "h"]).assign(holdout=h)
                    for h in LEAGUES], ignore_index=True)
    keys = ["holdout", "kind", "t", "h"]

    def full(n):
        return np.concatenate([preds[n][h] for h in LEAGUES])

    def derived(n):
        how, parts = DERIVED[n]
        if not all(have(q) for q in parts):
            return None
        if how == "avg":
            return np.mean([full(q) for q in parts], axis=0)
        return np.mean([df.assign(p=full(q)).groupby(keys, sort=False).p.rank(pct=True).values for q in parts], axis=0)

    names = [n for n in names if n not in DERIVED or derived(n) is not None]
    stats, overall = {}, {}
    for n in names:
        p = derived(n) if n in DERIVED else full(n)
        d = df.assign(pred=p)
        gs = group_stats(d)
        gs["tb"] = tbucket(gs.t.values)
        stats[n] = gs
        rank_only = any(s in n for s in RANK_ONLY)
        overall[n] = {
            "pooled rho": spearmanr(p, df.y)[0], "per-scn rho": gs.rho.mean(), "top10 logret": gs.top10.mean(),
            "top10 hit%": gs.hit.mean() * 100, "top10 arith": gs.arith.mean(), "top25 logret": gs.top25.mean(),
            "dir acc%": np.nan if rank_only else ((p >= 0) == (df.y.values >= 0)).mean() * 100,
            "MAE log": np.nan if rank_only else np.abs(p - df.y.values).mean(),
        }
    pd.set_option("display.width", 250)
    print("\n=========== ALL EARLY-LEAGUE SCENARIOS (t 0-25), pooled over the 5 holdouts ===========")
    print(pd.DataFrame(overall).T.round(4).to_string())

    def table(title, col, mask=lambda g: g.rho == g.rho):
        rows = {}
        for n in names:
            g = stats[n][mask(stats[n])]
            rows[n] = g.groupby("tb")[col].mean().reindex(["t=0", "t=2-4", "t=7-10", "t=14-25"])
            rows[n]["ALL"] = g[col].mean()
        print(f"\n=========== {title} ===========")
        print(pd.DataFrame(rows).T.round(4).to_string())

    table("PER-SCENARIO SPEARMAN by league-day bucket - ALL kinds", "rho")
    table("PER-SCENARIO SPEARMAN by league-day bucket - CURRENCY only", "rho", lambda g: g.kind == "currency")
    table("TOP-10% mean log-return by league-day bucket - CURRENCY only", "top10", lambda g: g.kind == "currency")
    table("TOP-10% mean log-return by league-day bucket - ITEMS only", "top10", lambda g: g.kind == "item")
    table("TOP-10% hit rate by league-day bucket - ALL kinds", "hit")
    table("TOP-10% mean ARITHMETIC return (capped 10x) by league-day bucket - CURRENCY only", "arith", lambda g: g.kind == "currency")
    per = {n: {h: stats[n][stats[n].holdout == h].rho.mean() for h in LEAGUES} for n in names}
    print("\n=========== PER-SCENARIO SPEARMAN per holdout league ===========")
    p = pd.DataFrame(per).T
    p["min"] = p.min(1)
    print(p.round(4).to_string())


if __name__ == "__main__":
    cmd, args = (sys.argv[1] if len(sys.argv) > 1 else "run"), sys.argv[2:]
    {"run": run, "report": report}[cmd](args)
