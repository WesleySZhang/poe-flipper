"""Builds the leave-one-league-out train/test sets once (all feature groups) and caches them as parquet, so the
many model variants in explore.py don't each pay the feature-engineering cost. Same nested-exclusion protocol
as run_experiment.make_folds; test rows are exactly production's matched rows."""
import os
import time
import warnings

warnings.filterwarnings("ignore")
import pandas as pd

import run_experiment as rx
from features import LEAGUES, History

OUT = os.path.join(rx.CACHE, "folds")


def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    base = rx.load_baseline()
    cmap = base[base.kind == "currency"].drop_duplicates("key").set_index("key").category.to_dict()
    hist = History(category_map_currency=cmap)
    print(f"history ready ({time.time()-t0:.0f}s), {hist.n_categories} categories", flush=True)
    folds = rx.make_folds(hist, base, 2)
    for h, (train, test) in folds.items():
        train.drop(columns=["key"]).to_parquet(os.path.join(OUT, f"{h}_train.parquet"))
        test.to_parquet(os.path.join(OUT, f"{h}_test.parquet"))
        mb = train.memory_usage(deep=True).sum() / 1e6
        print(f"{h:12s} train {len(train):>10,} rows ({mb:,.0f} MB)   test {len(test):>9,} rows   ({time.time()-t0:.0f}s)", flush=True)
    pd.Series({"n_cat": hist.n_categories}).to_json(os.path.join(OUT, "meta.json"))
    print(f"done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
