"""
Feature engineering for the ML-vs-production comparison (see ml/README.md).

Everything here is computed from DuckDB's *_history_dayed tables. The point of this module is that
each row's features use ONLY information the deployed app would actually have when predicting a
brand-new league:

  * other leagues' full trajectories for the same item (the "reference" leagues),
  * the item's price *now* in the target league (live poe.ninja price) and the divine orb's price now,
  * the league day (t) and horizon (h).

It never touches the target league's own future (label) or its own past history (the current league
has no day-by-day history in production - lib/price-history.ts).
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import duckdb
import numpy as np
import pandas as pd

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "db", "history.duckdb")
TOLERANCE = 3  # matches lib/growth-ratios.ts DEFAULT_TOLERANCE_DAYS
MAX_DAY = 34  # 30-day max target + tolerance
LEAGUES = ["Settlers", "Mercenaries", "Keepers", "Phrecia 2.0", "Mirage"]  # oldest -> newest

START_DAYS = [0, 2, 4, 7, 10, 14, 18, 21, 25]
DURATIONS = [2, 3, 5, 7, 10, 14, 20, 25, 30]
SCENARIOS = [(t, h) for t in START_DAYS for h in DURATIONS if t + h <= 30]


def _nearest_fill(raw: np.ndarray) -> np.ndarray:
    """Fill NaNs with the nearest available day within +-TOLERANCE (ties -> earlier day), mirroring
    getActual*ValueAtDay's ROW_NUMBER() OVER (ORDER BY ABS(day_offset - day))."""
    out = raw.copy()
    for dist in range(1, TOLERANCE + 1):
        for sign in (-1, 1):
            shifted = np.full_like(raw, np.nan)
            if sign == -1:  # value from day d-dist
                shifted[:, dist:] = raw[:, :-dist]
            else:  # value from day d+dist
                shifted[:, :-dist] = raw[:, dist:]
            m = np.isnan(out)
            out[m] = shifted[m]
    return out


@dataclass
class KindData:
    keys: list[str]
    key_index: dict[str, int]
    category: np.ndarray  # int codes
    logv: dict[str, np.ndarray]  # league -> (n_keys, D) log chaos value, nearest-filled


class History:
    def __init__(self, category_map_currency: dict[str, str] | None = None, max_day: int = MAX_DAY):
        con = duckdb.connect(DB_PATH, read_only=True)
        D = max_day + 1

        cur = con.sql(
            f"select league, name as key, value, day_offset from currency_history_dayed "
            f"where day_offset <= {max_day} and value > 0"
        ).df()
        itm = con.sql(
            f"select league, case when variant is null or variant = '' then name else name || '::' || variant end as key, "
            f"value, day_offset, type from item_history_dayed where day_offset <= {max_day} and value > 0"
        ).df()
        div = con.sql(
            f"select league, day_offset, chaos_per_divine from divine_rate_dayed where day_offset <= {max_day}"
        ).df()
        con.close()

        self.category_names: list[str] = []
        cat_code: dict[str, int] = {}

        def code(cat: str) -> int:
            if cat not in cat_code:
                cat_code[cat] = len(cat_code)
                self.category_names.append(cat)
            return cat_code[cat]

        # divine log rate per league/day, nearest-filled
        self.logdiv: dict[str, np.ndarray] = {}
        for lg in LEAGUES:
            arr = np.full((1, D), np.nan, dtype=np.float32)
            sub = div[div.league == lg]
            arr[0, sub.day_offset.values] = np.log(sub.chaos_per_divine.values)
            self.logdiv[lg] = _nearest_fill(arr)[0]

        self.kinds: dict[str, KindData] = {}
        for kind, df in (("currency", cur), ("item", itm)):
            keys = sorted(df.key.unique())
            kidx = {k: i for i, k in enumerate(keys)}
            if kind == "item":
                # one category per key: the type from the most recent league it appears in
                latest = df.sort_values("league", key=lambda s: s.map({l: i for i, l in enumerate(LEAGUES)})).drop_duplicates(
                    "key", keep="last"
                )
                cats = latest.set_index("key").type.reindex(keys).fillna("Unknown").tolist()
            else:
                cmap = category_map_currency or {}
                cats = [cmap.get(k, "Currency") for k in keys]
            catarr = np.array([code(c) for c in cats], dtype=np.int32)
            logv = {}
            for lg in LEAGUES:
                arr = np.full((len(keys), D), np.nan, dtype=np.float32)
                sub = df[df.league == lg]
                # duplicate (key, day) rows would be a data bug; keep last defensively
                arr[sub.key.map(kidx).values, sub.day_offset.values] = np.log(sub.value.values).astype(np.float32)
                logv[lg] = _nearest_fill(arr)
            self.kinds[kind] = KindData(keys, kidx, catarr, logv)

    @property
    def n_categories(self) -> int:
        return len(self.category_names)


FEATURE_COLS = [
    "t", "h", "cat",
    "n_ref", "ref_mean", "ref_median", "ref_std", "ref_min", "ref_max", "ref_up",
    "nd_ref", "refd_mean", "refd_std", "refd_up",
    "ref_div_drift",
    "x_now", "x_now_div", "rel_level", "rel_level_div", "ref_level_std",
    "ref_pre_mean", "macro_div_rel", "div_now",
    "peer_ref_mean", "peer_refd_mean", "peer_rel_level", "peer_n", "shrunk_base",
    "ref_mean_pct", "rel_level_pct",
]


def scenario_features(
    hist: History,
    kind: str,
    target: str,
    refs: list[str],
    t: int,
    h: int,
    min_ref: int,
) -> pd.DataFrame:
    """One row per key present in `target` at both t and t+h with >= min_ref reference leagues
    having both days. Includes label columns y (log chaos ratio) and yd (log divine ratio)."""
    kd = hist.kinds[kind]
    Vt = kd.logv[target]
    x_now = Vt[:, t]
    x_fut = Vt[:, t + h]
    valid = ~np.isnan(x_now) & ~np.isnan(x_fut)

    R = len(refs)
    ref_now = np.stack([kd.logv[l][:, t] for l in refs])  # (R, K)
    ref_fut = np.stack([kd.logv[l][:, t + h] for l in refs])
    r = ref_fut - ref_now  # log chaos ratio per ref league
    ref_ok = ~np.isnan(r)
    n_ref = ref_ok.sum(0)
    valid &= n_ref >= min_ref
    if not valid.any():
        return pd.DataFrame()

    ld_ref_now = np.stack([hist.logdiv[l][t] * np.ones(ref_now.shape[1], dtype=np.float32) for l in refs])
    ld_ref_fut = np.stack([hist.logdiv[l][t + h] * np.ones(ref_now.shape[1], dtype=np.float32) for l in refs])
    rd = r - (ld_ref_fut - ld_ref_now)  # log divine-denominated ratio per ref
    rd_ok = ~np.isnan(rd)

    with np.errstate(all="ignore"):
        idx = np.where(valid)[0]
        r_v, rd_v = r[:, idx], rd[:, idx]
        n = ref_ok[:, idx].sum(0)
        nd = rd_ok[:, idx].sum(0)
        ref_mean = np.nanmean(r_v, 0)
        ref_median = np.nanmedian(r_v, 0)
        ref_std = np.where(n >= 2, np.nanstd(r_v, 0, ddof=1), np.nan)
        ref_min = np.nanmin(r_v, 0)
        ref_max = np.nanmax(r_v, 0)
        ref_up = np.nansum(r_v > 0, 0) / n
        refd_mean = np.nanmean(rd_v, 0)
        refd_std = np.where(nd >= 2, np.nanstd(rd_v, 0, ddof=1), np.nan)
        refd_up = np.nansum(rd_v > 0, 0) / np.maximum(nd, 1)

        ref_div_drift = float(np.nanmean([hist.logdiv[l][t + h] - hist.logdiv[l][t] for l in refs]))
        div_now_t = hist.logdiv[target][t]
        ref_div_now = float(np.nanmean([hist.logdiv[l][t] for l in refs]))
        macro_div_rel = div_now_t - ref_div_now

        xn = x_now[idx]
        xnd = xn - div_now_t
        ref_lvl = ref_now[:, idx]
        ref_lvl_mean = np.nanmean(ref_lvl, 0)
        ref_lvl_div_mean = np.nanmean(ref_lvl - np.array([hist.logdiv[l][t] for l in refs])[:, None], 0)
        rel_level = xn - ref_lvl_mean
        rel_level_div = xnd - ref_lvl_div_mean
        ref_level_std = np.where(np.sum(~np.isnan(ref_lvl), 0) >= 2, np.nanstd(ref_lvl, 0, ddof=1), np.nan)

        if t > 0:
            pre = np.stack([kd.logv[l][:, 0][idx] for l in refs])
            ref_pre_mean = np.nanmean(ref_now[:, idx] - pre, 0)
        else:
            ref_pre_mean = np.full(len(idx), np.nan, dtype=np.float32)

    df = pd.DataFrame(
        {
            "t": t, "h": h,
            "cat": kd.category[idx],
            "key": np.array(kd.keys, dtype=object)[idx],
            "n_ref": n, "ref_mean": ref_mean, "ref_median": ref_median, "ref_std": ref_std,
            "ref_min": ref_min, "ref_max": ref_max, "ref_up": ref_up,
            "nd_ref": nd, "refd_mean": refd_mean, "refd_std": refd_std, "refd_up": refd_up,
            "ref_div_drift": ref_div_drift,
            "x_now": xn, "x_now_div": xnd, "rel_level": rel_level, "rel_level_div": rel_level_div,
            "ref_level_std": ref_level_std, "ref_pre_mean": ref_pre_mean,
            "macro_div_rel": macro_div_rel, "div_now": div_now_t,
            "y": (x_fut[idx] - x_now[idx]),
        }
    )
    # divine-denominated label
    df["yd"] = df["y"] - (hist.logdiv[target][t + h] - hist.logdiv[target][t])

    # Peer-group aggregates within this (scenario, category) - built from reference-league stats only
    g = df.groupby("cat")
    df["peer_ref_mean"] = g["ref_mean"].transform("mean")
    df["peer_refd_mean"] = g["refd_mean"].transform("mean")
    df["peer_rel_level"] = g["rel_level"].transform("mean")
    df["peer_n"] = g["ref_mean"].transform("count")
    df["shrunk_base"] = 0.5 * df["ref_mean"] + 0.5 * df["peer_ref_mean"]
    df["ref_mean_pct"] = df["ref_mean"].rank(pct=True)
    df["rel_level_pct"] = df["rel_level"].rank(pct=True)
    df["kind"] = kind
    return df


def build_dataset(
    hist: History,
    target: str,
    refs: list[str],
    min_ref: int,
    scenarios=SCENARIOS,
    kinds=("currency", "item"),
) -> pd.DataFrame:
    parts = []
    for kind in kinds:
        for (t, h) in scenarios:
            d = scenario_features(hist, kind, target, refs, t, h, min_ref)
            if len(d):
                parts.append(d)
    if not parts:
        return pd.DataFrame()
    out = pd.concat(parts, ignore_index=True)
    out["target"] = target
    return out
