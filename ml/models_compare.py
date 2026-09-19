"""Does the gain need machine learning, or is it the mean-reversion *feature* that matters?
Compares simple linear models, XGBoost variants, and a GPU MLP under the same leave-one-league-out."""
import time
import warnings

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import xgboost as xgb
from sklearn.linear_model import Ridge

warnings.filterwarnings("ignore")
import run_experiment as rx
from features import FEATURE_COLS, LEAGUES, History

dev = torch.device("cuda")
NUMERIC = [c for c in FEATURE_COLS if c != "cat"]


def design(df, mu=None, sd=None):
    X = df[NUMERIC].astype("float32").values
    miss = np.isnan(X)
    if mu is None:
        mu = np.nanmean(X, 0)
        sd = np.nanstd(X, 0) + 1e-6
    Xs = np.where(miss, 0.0, (X - mu) / sd).astype("float32")
    Xs = np.clip(Xs, -6, 6)
    return np.hstack([Xs, miss.astype("float32")]), mu, sd


def fit_ridge(train, cols, alpha=10.0):
    X = train[cols].astype("float32").values
    mu, sd = np.nanmean(X, 0), np.nanstd(X, 0) + 1e-6
    f = lambda d: np.nan_to_num((d[cols].astype("float32").values - mu) / sd)
    m = Ridge(alpha=alpha).fit(f(train), train.y.clip(-rx.Y_CLIP, rx.Y_CLIP).values)
    return lambda d: m.predict(f(d))


class MLP(nn.Module):
    def __init__(self, d_in, n_cat, width=256):
        super().__init__()
        self.emb = nn.Embedding(n_cat, 8)
        self.net = nn.Sequential(
            nn.Linear(d_in + 8, width), nn.GELU(), nn.Dropout(0.1),
            nn.Linear(width, width), nn.GELU(), nn.Dropout(0.1),
            nn.Linear(width, width // 2), nn.GELU(),
            nn.Linear(width // 2, 1),
        )

    def forward(self, x, c):
        return self.net(torch.cat([x, self.emb(c)], 1)).squeeze(1)


def fit_mlp(train, n_cat, epochs=6, seed=0):
    torch.manual_seed(seed)
    X, mu, sd = design(train)
    y = train.y.clip(-rx.Y_CLIP, rx.Y_CLIP).values.astype("float32")
    Xg = torch.tensor(X, device=dev)
    cg = torch.tensor(train.cat.values.astype("int64"), device=dev)
    yg = torch.tensor(y, device=dev)
    model = MLP(X.shape[1], n_cat).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-2)
    n = len(y)
    steps = epochs * (n // 8192 + 1)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps)
    lossf = nn.HuberLoss(delta=0.5)
    for ep in range(epochs):
        perm = torch.randperm(n, device=dev)
        model.train()
        for i in range(0, n, 8192):
            idx = perm[i : i + 8192]
            opt.zero_grad()
            loss = lossf(model(Xg[idx], cg[idx]), yg[idx])
            loss.backward()
            opt.step()
            sched.step()
    model.eval()

    def predict(d):
        Xt, _, _ = design(d, mu, sd)
        with torch.no_grad():
            return model(torch.tensor(Xt, device=dev), torch.tensor(d.cat.values.astype("int64"), device=dev)).cpu().numpy()

    return predict


def main():
    t0 = time.time()
    print("GPU:", torch.cuda.get_device_name(0))
    base = rx.load_baseline()
    cmap = base[base.kind == "currency"].drop_duplicates("key").set_index("key").category.to_dict()
    hist = History(category_map_currency=cmap)
    folds = rx.make_folds(hist, base, 2)
    n_cat = hist.n_categories
    rx.FEATURE_COLS[:] = FEATURE_COLS

    variants = {}
    def add(name, fn):
        preds = []
        for h in LEAGUES:
            train, test = folds[h]
            preds.append(fn(train, test))
        variants[name] = np.concatenate(preds)
        print(f"  {name:48s} done ({time.time()-t0:.0f}s)", flush=True)

    add("production", lambda tr, te: te.log_pred.values)
    add("linear: shrunk_base only", lambda tr, te: fit_ridge(tr, ["shrunk_base"])(te))
    add("linear: shrunk_base + rel_level_pct", lambda tr, te: fit_ridge(tr, ["shrunk_base", "rel_level_pct"])(te))
    add("linear: shrunk_base + rel_level_pct + x_now_div",
        lambda tr, te: fit_ridge(tr, ["shrunk_base", "rel_level_pct", "x_now_div"])(te))
    lin_cols = ["shrunk_base", "ref_mean", "ref_std", "ref_up", "refd_mean", "rel_level", "rel_level_div",
                "rel_level_pct", "peer_rel_level", "x_now", "x_now_div", "macro_div_rel", "ref_div_drift", "t", "h"]
    add("linear: 15 features", lambda tr, te: fit_ridge(tr, lin_cols)(te))

    def xgbfit(params, rounds):
        def f(tr, te):
            m = rx.fit_xgb(tr, n_cat, params, rounds)
            return rx.predict_xgb(m, te, n_cat)
        return f
    add("xgb depth4 300r", xgbfit({"max_depth": 4}, 300))
    add("xgb depth6 400r (earlier config)", xgbfit({}, 400))
    add("xgb depth8 400r", xgbfit({"max_depth": 8, "min_child_weight": 200}, 400))
    add("xgb depth6 1000r eta0.02", xgbfit({"eta": 0.02}, 1000))
    add("xgb pseudo-Huber", xgbfit({"objective": "reg:pseudohubererror", "huber_slope": 0.5}, 400))

    add("MLP (GPU) seed0", lambda tr, te: fit_mlp(tr, n_cat, seed=0)(te))
    add("MLP (GPU) seed1", lambda tr, te: fit_mlp(tr, n_cat, seed=1)(te))
    variants["MLP 2-seed avg"] = (variants["MLP (GPU) seed0"] + variants["MLP (GPU) seed1"]) / 2
    variants["ensemble: xgb400 + MLP avg"] = (variants["xgb depth6 400r (earlier config)"] + variants["MLP 2-seed avg"]) / 2

    df = pd.concat([folds[h][1][["y", "kind", "t", "h"]].assign(holdout=h) for h in LEAGUES], ignore_index=True)
    rows, per_league = {}, {}
    for name, p in variants.items():
        rows[name] = rx.score(df, p)
        per_league[name] = {}
        off = 0
        for h in LEAGUES:
            n = len(folds[h][1])
            per_league[name][h] = rx.score(df.iloc[off : off + n].drop(columns="holdout"), p[off : off + n])["spearman"]
            off += n
    cols = ["spearman", "spearman_per_scenario", "top10_mean_logret", "top10_pct_gained", "dir_acc", "mae_log"]
    print("\n================ POOLED (5 holdouts) ================")
    print(pd.DataFrame(rows).T[cols].round(4).to_string())
    pl = pd.DataFrame(per_league).T
    pl["min"] = pl.min(1)
    print("\n================ SPEARMAN PER HOLDOUT ================")
    print(pl.round(4).to_string())
    print(f"\ntotal {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
