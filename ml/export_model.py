"""Trains the portable 21-feature XGBoost model on ALL five leagues (each league a target, features from the other
four - same nested exclusion as validation), exports the trees to a compact JSON a TypeScript evaluator can walk,
and writes a parity set so eval_model.mjs can prove the JS output equals XGBoost's. Measures file size.

Deployment-cost probe for the free tiers: nothing here touches db/history.duckdb or Git LFS - the model is a
plain file (a few MB at most), committed like source."""
import gzip
import json
import os
import time
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
import explore as ex
import run_experiment as rx
from features import LEAGUES, History, build_dataset

OUT = os.path.join(rx.CACHE, "export")
ROUNDS = int(os.environ.get("ROUNDS", 400))
PARAMS = {**ex.HUBER, **ex.D8, "eta": float(os.environ.get("ETA", 0.05))}


def compact(booster, cols):
    cfg = json.loads(booster.save_config())
    raw_base = cfg["learner"]["learner_model_param"]["base_score"]  # xgboost 3.x prints it as "[5.02E-2]"
    base = float(str(raw_base).strip("[]"))
    dump = json.loads(booster.save_raw("json"))
    trees = dump["learner"]["gradient_booster"]["model"]["trees"]
    F, C, L, R, D = [], [], [], [], []
    roots = []
    for t in trees:
        roots.append(len(F))
        off = len(F)
        for i in range(len(t["split_indices"])):
            leaf = t["left_children"][i] == -1
            F.append(-1 if leaf else t["split_indices"][i])
            C.append(float(np.float32(t["base_weights"][i] if leaf else t["split_conditions"][i])))  # exact float32, no rounding
            L.append(-1 if leaf else t["left_children"][i] + off)
            R.append(-1 if leaf else t["right_children"][i] + off)
            D.append(1 if t["default_left"][i] else 0)
    return {"features": cols, "base_score": base, "roots": roots, "f": F, "c": C, "l": L, "r": R, "d": D}


def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    base = rx.load_baseline()
    cmap = base[base.kind == "currency"].drop_duplicates("key").set_index("key").category.to_dict()
    hist = History(category_map_currency=cmap)
    parts = [build_dataset(hist, lt, [l for l in LEAGUES if l != lt], min_ref=2) for lt in LEAGUES]
    train = pd.concat(parts, ignore_index=True)
    print(f"training rows {len(train):,} ({time.time()-t0:.0f}s)")

    predict, m = ex.fit_xgb(train, ex.PORT, PARAMS, ROUNDS)
    print(f"trained {ROUNDS} trees on GPU ({time.time()-t0:.0f}s)")

    model = compact(m, ex.PORT)
    raw_path = os.path.join(OUT, "port_model.json")
    json.dump(model, open(raw_path, "w"), separators=(",", ":"))
    size = os.path.getsize(raw_path)
    gz = len(gzip.compress(open(raw_path, "rb").read(), 9))
    print(f"trees {len(model['roots'])}, nodes {len(model['f']):,}  ->  {size/1e6:.2f} MB raw JSON, {gz/1e6:.2f} MB gzipped")

    # parity set: one realistic item scenario + one currency scenario, straight from the training frame
    sample = pd.concat([train[(train.kind == "item") & (train.t == 14) & (train.h == 7) & (train.target == "Mirage")],
                        train[(train.kind == "currency") & (train.t == 7) & (train.h == 14) & (train.target == "Mirage")]])
    X = sample[ex.PORT].astype("float32")
    py = predict(sample)
    json.dump({"rows": [[None if np.isnan(v) else float(v) for v in r] for r in X.values], "py": [float(v) for v in py]},
              open(os.path.join(OUT, "parity.json"), "w"), separators=(",", ":"))
    print(f"parity set: {len(sample):,} rows -> {OUT}")
    print(f"total {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
