"""Sanity check: does the Python feature pipeline reproduce production's row universe, labels, and
(approximately) its predictions? Run before trusting any model built on these features."""
import os
import time

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from features import History, LEAGUES, build_dataset

CACHE = os.path.join(os.path.dirname(__file__), "cache")

t0 = time.time()
base = pd.read_csv(os.path.join(CACHE, "baseline_rows.csv"))
print(f"baseline rows: {len(base):,}  ({time.time()-t0:.1f}s)")

cmap = base[base.kind == "currency"].drop_duplicates("key").set_index("key").category.to_dict()
hist = History(category_map_currency=cmap)
print(f"history built ({time.time()-t0:.1f}s); categories: {hist.n_categories}")

for holdout in ["Mirage", "Keepers"]:
    refs = [l for l in LEAGUES if l != holdout]
    mine = build_dataset(hist, holdout, refs, min_ref=3)
    b = base[base.holdout == holdout].copy()
    b["y_prod"] = np.log(b.actual_ratio)
    b["log_pred"] = np.log(b.pred_ratio)
    m = mine.merge(
        b, left_on=["kind", "t", "h", "key"], right_on=["kind", "current_day", "duration", "key"], how="inner"
    )
    print(f"\n=== holdout {holdout} ===")
    print(f"production rows: {len(b):,}   my rows: {len(mine):,}   joined: {len(m):,}"
          f"   ({len(m)/len(b):.1%} of production rows reproduced)")
    print(f"label agreement: max |my y - prod log(actual_ratio)| = {np.abs(m.y - m.y_prod).max():.4f}, "
          f"median {np.abs(m.y - m.y_prod).median():.6f}")
    for col in ["ref_mean", "shrunk_base"]:
        ok = m[col].notna()
        print(f"corr(log prod pred, {col}) = {np.corrcoef(m.log_pred[ok], m[col][ok])[0,1]:.4f}   "
              f"spearman = {spearmanr(m.log_pred[ok], m[col][ok])[0]:.4f}")
    ok = m.shrunk_base.notna()
    print(f"spearman vs ACTUAL: production={spearmanr(m.log_pred, m.y_prod)[0]:.4f}   "
          f"my shrunk_base={spearmanr(m.shrunk_base[ok], m.y_prod[ok])[0]:.4f}")
print(f"\ntotal {time.time()-t0:.1f}s")
