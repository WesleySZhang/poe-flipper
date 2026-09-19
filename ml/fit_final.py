"""Fits the simple 2-feature mean-reversion model on ALL 5 leagues (each league as target, features from the
other 4) and prints raw coefficients + effect sizes - for a possible production port. Not a validation
(in-sample); validation is run_experiment.py / run_late.py."""
import warnings
import numpy as np, pandas as pd
warnings.filterwarnings("ignore")
import run_experiment as rx
from features import LEAGUES, SCENARIOS as EARLY, History, build_dataset
from sklearn.linear_model import LinearRegression

LATE = [(t, h) for t in [30,35,40,50,60,75,90,110] for h in [3,7,14,21,30] if t + h <= 133]
base = rx.load_baseline()
cmap = base[base.kind == "currency"].drop_duplicates("key").set_index("key").category.to_dict()
hist = History(category_map_currency=cmap, max_day=133)
for name, scen in [("EARLY (day<=30)", EARLY), ("LATE (day 30-110)", LATE)]:
    parts = [build_dataset(hist, lt, [l for l in LEAGUES if l != lt], min_ref=2, scenarios=scen) for lt in LEAGUES]
    d = pd.concat([p for p in parts if len(p)], ignore_index=True).dropna(subset=["shrunk_base", "rel_level_pct"])
    y = d.y.clip(-rx.Y_CLIP, rx.Y_CLIP)
    m = LinearRegression().fit(d[["shrunk_base", "rel_level_pct"]], y)
    a, b = m.coef_
    print(f"\n{name}: n={len(d):,}")
    print(f"  pred_logret = {m.intercept_:+.4f} + {a:.4f} * shrunk_base + {b:+.4f} * rel_level_pct")
    print(f"  -> an item at the 90th percentile of 'price vs. same-day history' is predicted {b*(0.9-0.1):+.3f} log-return "
          f"(= {np.exp(b*0.8)-1:+.1%}) vs. one at the 10th percentile, holding the historical ratio equal")
    print(f"  -> weight on production's own signal (shrunk_base): {a:.2f}  (1.0 would mean 'trust it fully')")
