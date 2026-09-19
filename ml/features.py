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
import warnings
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


def _causal_fill(raw: np.ndarray) -> np.ndarray:
    """Fill NaNs from the nearest PAST day within TOLERANCE only. Used for the target league's own
    momentum features, so they can never see a day after `t` (nearest-fill above may borrow from d+1..d+3)."""
    out = raw.copy()
    for dist in range(1, TOLERANCE + 1):
        shifted = np.full_like(raw, np.nan)
        shifted[:, dist:] = raw[:, :-dist]
        m = np.isnan(out)
        out[m] = shifted[m]
    return out


@dataclass
class KindData:
    keys: list[str]
    key_index: dict[str, int]
    category: np.ndarray  # int codes
    logv: dict[str, np.ndarray]  # league -> (n_keys, D) log chaos value, nearest-filled
    logv_c: dict[str, np.ndarray]  # same, causally filled (past days only) - target's own-history features


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
        self.logdiv_c: dict[str, np.ndarray] = {}
        for lg in LEAGUES:
            arr = np.full((1, D), np.nan, dtype=np.float32)
            sub = div[div.league == lg]
            arr[0, sub.day_offset.values] = np.log(sub.chaos_per_divine.values)
            self.logdiv[lg] = _nearest_fill(arr)[0]
            self.logdiv_c[lg] = _causal_fill(arr)[0]

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
            logv, logv_c = {}, {}
            for lg in LEAGUES:
                arr = np.full((len(keys), D), np.nan, dtype=np.float32)
                sub = df[df.league == lg]
                # duplicate (key, day) rows would be a data bug; keep last defensively
                arr[sub.key.map(kidx).values, sub.day_offset.values] = np.log(sub.value.values).astype(np.float32)
                logv[lg] = _nearest_fill(arr)
                logv_c[lg] = _causal_fill(arr)
            self.kinds[kind] = KindData(keys, kidx, catarr, logv, logv_c)

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

# ---- momentum: the target league's own last-7-days path. poe.ninja's live API returns exactly this
# (a 7-point sparkline of daily % change, verified to match the stored daily history point for point),
# so these are available for a live league even though it has no stored history of its own.
MOM_COLS = [
    "mom1", "mom3", "mom6", "vol6", "accel",           # own recent trend / shape
    "ref_mom6", "rel_mom6", "rel_mom3",                 # ... relative to what past leagues did at the same day
    "mom6_pct", "rel_mom6_pct", "mom6_dm", "mkt_mom6", "peer_mom6",  # cross-sectional / market context
    "div_mom6", "rel_div_mom6",                         # the divine orb's own momentum (chaos debasement pace)
]
# ---- analog forecasting + convergence: use each past league's OWN ratio, weighted by how similar its
# situation at day t was (momentum-matched / level-matched), instead of a flat average.
ANALOG_COLS = ["r_last", "r_prev", "analog_mom", "analog_lvl", "conv_full", "rel_level_w"]
# ---- full own-history features: NOT available live today (the app stores no daily history for the
# current league). Used only to measure how much a daily price log for the live league would add.
HIST_COLS = ["growth0", "rel_growth0", "dd_peak", "above_mean", "mom14"]
# ---- denoising: single-day prices are noisy, so average the reference ratio over shifted endpoints (t+d,
# t+h+d for d in -2..2) and compare a 3-day-smoothed level (the sparkline gives the last 7 days live).
SMOOTH_COLS = ["ref_mean_sm", "peer_ref_sm", "shrunk_sm", "dev_sm3", "rel_level_sm", "rel_level_sm_pct"]
KIND_COLS = ["is_cur"]
NEW_COLS = MOM_COLS + ANALOG_COLS + HIST_COLS + SMOOTH_COLS + KIND_COLS


def _nth_last_valid(A: np.ndarray, n: int) -> np.ndarray:
    """Along axis 0 (ordered oldest -> newest league), the n-th most recent non-NaN value per column."""
    out = np.full(A.shape[1], np.nan, dtype=np.float32)
    seen = np.zeros(A.shape[1], dtype=int)
    for i in range(A.shape[0] - 1, -1, -1):
        v = A[i]
        ok = ~np.isnan(v)
        take = ok & (seen == n - 1)
        out[take] = v[take]
        seen += ok
    return out


def _weighted_mean(vals: np.ndarray, w: np.ndarray) -> np.ndarray:
    ok = ~np.isnan(vals)
    ww = np.where(ok, w, 0.0)
    return np.where(ww.sum(0) > 0, np.where(ok, vals * w, 0.0).sum(0) / np.maximum(ww.sum(0), 1e-12), np.nan)


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

        # ---------------- momentum (target's own last-7-days path; causal, never past day t) ----------
        Cc = kd.logv_c[target]
        nan_n = np.full(len(idx), np.nan, dtype=np.float32)

        def lag(k):
            return (Cc[idx, t] - Cc[idx, t - k]).astype(np.float32) if t >= k else nan_n

        def ref_lag(k):
            return np.stack([kd.logv[l][idx, t] - kd.logv[l][idx, t - k] for l in refs]) if t >= k else None

        mom1, mom3, mom6 = lag(1), lag(3), lag(6)
        if t >= 6:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                vol6 = np.nanstd(np.diff(Cc[idx, t - 6 : t + 1], axis=1), axis=1).astype(np.float32)
                rm6, rm3 = ref_lag(6), ref_lag(3)
                ref_mom6, ref_mom3 = np.nanmean(rm6, 0), np.nanmean(rm3, 0)
                ref_div_mom6 = float(np.nanmean([hist.logdiv[l][t] - hist.logdiv[l][t - 6] for l in refs]))
            accel = mom3 - (mom6 - mom3)
            div_mom6 = float(hist.logdiv_c[target][t] - hist.logdiv_c[target][t - 6])
            rel_div_mom6 = div_mom6 - ref_div_mom6
        else:
            vol6, accel, ref_mom6, ref_mom3, rm6 = nan_n, nan_n, nan_n, nan_n, None
            div_mom6 = rel_div_mom6 = np.nan
        rel_mom6, rel_mom3 = mom6 - ref_mom6, mom3 - ref_mom3

        # ---------------- analog forecasting: weight each past league's own ratio by similarity --------
        r_last, r_prev = _nth_last_valid(r_v, 1), _nth_last_valid(r_v, 2)
        if rm6 is not None:  # momentum-matched: leagues whose item was moving like this one at day t
            w_mom = np.exp(-0.5 * ((mom6[None, :] - rm6) / 0.2) ** 2)
            w_mom = np.where(np.isnan(w_mom), 0.0, w_mom) + 1e-3  # no signal -> equal weights
            analog_mom = _weighted_mean(r_v, w_mom).astype(np.float32)
        else:
            analog_mom = ref_mean
        w_lvl = np.exp(-0.5 * ((xn[None, :] - ref_lvl) / 0.7) ** 2)  # level-matched
        analog_lvl = _weighted_mean(r_v, np.where(np.isnan(w_lvl), 0.0, w_lvl) + 1e-3).astype(np.float32)
        conv_full = ref_mean - rel_level  # "converge to the reference leagues' price at t+h"
        rel_level_w = np.clip(rel_level, -2, 2)

        # ---------------- own-history features (NOT available live; measures value of a daily price log) ----
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            growth0 = (xn - Cc[idx, 0]).astype(np.float32)
            rel_growth0 = growth0 - ref_pre_mean
            dd_peak = (xn - np.nanmax(Cc[idx, : t + 1], axis=1)).astype(np.float32)
            above_mean = (xn - np.nanmean(Cc[idx, : t + 1], axis=1)).astype(np.float32)
        mom14 = lag(14)

        # ---------------- denoising ----------------
        D_all = Vt.shape[1]
        sm_parts = []
        for dlt in (-2, -1, 0, 1, 2):
            a, b = t + dlt, t + h + dlt
            if 0 <= a and b < D_all:
                sm_parts.append(np.stack([kd.logv[l][idx, b] - kd.logv[l][idx, a] for l in refs]))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            ref_mean_sm = np.nanmean(np.concatenate(sm_parts, axis=0), axis=0).astype(np.float32)
            lo_d = max(0, t - 2)
            xsm3 = np.nanmean(Cc[idx, lo_d : t + 1], axis=1).astype(np.float32)
            ref_lvl_sm = np.nanmean(np.stack([np.nanmean(kd.logv[l][idx, lo_d : t + 1], axis=1) for l in refs]), axis=0)
        dev_sm3 = xn - xsm3
        rel_level_sm = xsm3 - ref_lvl_sm

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
            "mom1": mom1, "mom3": mom3, "mom6": mom6, "vol6": vol6, "accel": accel,
            "ref_mom6": ref_mom6, "rel_mom6": rel_mom6, "rel_mom3": rel_mom3,
            "div_mom6": div_mom6, "rel_div_mom6": rel_div_mom6,
            "r_last": r_last, "r_prev": r_prev, "analog_mom": analog_mom, "analog_lvl": analog_lvl,
            "conv_full": conv_full, "rel_level_w": rel_level_w,
            "growth0": growth0, "rel_growth0": rel_growth0, "dd_peak": dd_peak, "above_mean": above_mean,
            "mom14": mom14,
            "ref_mean_sm": ref_mean_sm, "dev_sm3": dev_sm3, "rel_level_sm": rel_level_sm,
            "is_cur": float(kind == "currency"),
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
    # cross-sectional momentum context (same scenario, same kind): a rank, market mean and peer mean
    df["mkt_mom6"] = df["mom6"].mean()
    df["mom6_dm"] = df["mom6"] - df["mkt_mom6"]
    df["mom6_pct"] = df["mom6"].rank(pct=True)
    df["rel_mom6_pct"] = df["rel_mom6"].rank(pct=True)
    df["peer_mom6"] = g["mom6"].transform("mean")
    df["peer_ref_sm"] = g["ref_mean_sm"].transform("mean")
    df["shrunk_sm"] = 0.5 * df["ref_mean_sm"] + 0.5 * df["peer_ref_sm"]
    df["rel_level_sm_pct"] = df["rel_level_sm"].rank(pct=True)
    num = [c for c in NEW_COLS if c in df.columns]
    df[num] = df[num].astype("float32")
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
