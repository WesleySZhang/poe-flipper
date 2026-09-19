"""Causality test for the momentum / own-history features: blank out every day AFTER t in the target league's
causally-filled matrix and verify those features do not change. (The label and the row set come from the
separate nearest-filled matrix, so rows are unchanged; only the features under test see the wiped data.)"""
import copy

import numpy as np

from features import HIST_COLS, LEAGUES, MOM_COLS, History, scenario_features

CAUSAL_COLS = ["mom1", "mom3", "mom6", "vol6", "accel", "rel_mom6", "rel_mom3", "mom6_pct", "rel_mom6_pct",
               "mom6_dm", "mkt_mom6", "peer_mom6", "div_mom6", "rel_div_mom6", "analog_mom",
               "growth0", "rel_growth0", "dd_peak", "above_mean", "mom14"]


def main():
    hist = History()
    target, refs = "Mirage", [l for l in LEAGUES if l != "Mirage"]
    bad = 0
    for kind in ("currency", "item"):
        for (t, h) in [(7, 5), (14, 10), (21, 7), (25, 3)]:
            a = scenario_features(hist, kind, target, refs, t, h, 3)
            h2 = copy.deepcopy(hist)
            h2.kinds[kind].logv_c[target][:, t + 1 :] = np.nan  # future of the target league erased
            h2.logdiv_c[target][t + 1 :] = np.nan
            b = scenario_features(h2, kind, target, refs, t, h, 3)
            assert len(a) == len(b), "row set changed"
            for c in CAUSAL_COLS:
                same = np.allclose(a[c].values, b[c].values, equal_nan=True)
                if not same:
                    bad += 1
                    print(f"  LEAK? {kind} t={t} h={h}: column {c} changed when the future was erased")
            print(f"{kind:8s} t={t:2d} h={h:2d}: rows={len(a):6d}  causal columns unchanged: "
                  f"{all(np.allclose(a[c].values, b[c].values, equal_nan=True) for c in CAUSAL_COLS)}")
    print("\nRESULT:", "no leakage found" if bad == 0 else f"{bad} column(s) depend on future data")


if __name__ == "__main__":
    main()
