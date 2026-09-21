"""Test: is there a learnable lead-lag / co-movement signal BETWEEN currency items (e.g. "when X moves, Y tends
to follow N days later"), on top of the single-item mean-reversion + momentum signal the shipped model already
uses? Currency is the one part of the data dense enough (~190-200 items, daily coverage, few gaps) to estimate
pairwise relationships from; items (8M sparse rows) are not.

Method, per league (pooled across the 5 leagues we have, using log-return series so a pair's relationship is
scale-free):
  1. Build each currency's daily log-return series (log(value[d]/value[d-1])).
  2. For every ordered pair (X, Y) and lag in {1, 2, 3, 5, 7} days, correlate X's return on day d with Y's
     return on day d+lag - i.e. does X's move predict Y's FUTURE move (excludes lag=0, which is just
     same-day co-movement, not a usable predictive signal for a d -> d+lag forecast).
  3. Compare the distribution of |lead-lag correlation| against a shuffled-pairs null (same currencies,
     randomly permuted partner) to see if real pairs carry more signal than chance pairing would.
  4. For the strongest few pairs, sanity-check out-of-sample: does lag correlation estimated on leagues
     1-4 actually hold up (same sign, similar magnitude) on the held-out 5th league?

    python test_currency_leadlag.py
"""
import itertools
import os
import warnings

import duckdb
import numpy as np
import pandas as pd
from scipy.stats import ks_2samp, mannwhitneyu

warnings.filterwarnings("ignore")
DB = os.path.join(os.path.dirname(__file__), "..", "db", "history.duckdb")
LEAGUES = ["Settlers", "Mercenaries", "Keepers", "Phrecia 2.0", "Mirage"]
LAGS = [1, 2, 3, 5, 7]
MIN_OVERLAP = 60  # need at least this many paired (d, d+lag) observations to trust a pair's correlation


def load_returns(league):
    con = duckdb.connect(DB, read_only=True)
    df = con.execute(
        "select name, day_offset, value from currency_history_dayed where league = ? and value > 0 order by name, day_offset",
        [league],
    ).fetchdf()
    con.close()
    # pivot to a dense day x currency matrix (day_offset as index), then log-return
    wide = df.pivot_table(index="day_offset", columns="name", values="value")
    wide = wide.reindex(range(int(wide.index.min()), int(wide.index.max()) + 1))  # fill gaps with NaN, keep day order
    logv = np.log(wide)
    ret = logv.diff()  # ret.loc[d, name] = log(v[d]/v[d-1])
    return ret


def lag_corr(ret, x, y, lag):
    """corr(x's return on day d, y's return on day d+lag), NaN-safe pairwise."""
    a = ret[x].values[:-lag] if lag > 0 else ret[x].values
    b = ret[y].values[lag:] if lag > 0 else ret[y].values
    m = np.isfinite(a) & np.isfinite(b)
    if m.sum() < MIN_OVERLAP:
        return np.nan, int(m.sum())
    if np.std(a[m]) < 1e-12 or np.std(b[m]) < 1e-12:
        return np.nan, int(m.sum())
    return float(np.corrcoef(a[m], b[m])[0, 1]), int(m.sum())


def screen_league(ret, seed=0, n_null_shifts=3):
    """`real` = every ordered pair's lag-correlation. `null` = the SAME pairs, but y's series is circularly
    time-shifted by a random amount first - this destroys any genuine lead-lag relationship between x and y
    while exactly preserving each series' own autocorrelation, volatility clustering and marginal distribution
    (the thing a naive relabel-the-columns null gets wrong: with ~200 short, autocorrelated series, extreme
    |corr| values occur by chance at the SAME rate regardless of which two series are paired, so a null built
    by permuting pair identity is statistically indistinguishable from the real pairs and always was going to
    look like "no difference" - not evidence of an absence of signal, just the wrong control)."""
    names = [c for c in ret.columns if ret[c].notna().sum() >= MIN_OVERLAP + 10]
    rng = np.random.default_rng(seed)
    real_rows, null_rows = [], []
    pairs = list(itertools.permutations(names, 2))
    print(f"    {len(names)} currencies, {len(pairs):,} ordered pairs x {len(LAGS)} lags")
    for x, y in pairs:
        for lag in LAGS:
            c, n = lag_corr(ret, x, y, lag)
            if np.isfinite(c):
                real_rows.append((x, y, lag, c, n))
    n_days = len(ret)
    for shift_i in range(n_null_shifts):
        shift_by = {c: int(rng.integers(1, n_days - 1)) for c in names}
        ret_shifted = ret.copy()
        for c in names:
            ret_shifted[c] = np.roll(ret[c].values, shift_by[c])
        for x, y in pairs:
            for lag in LAGS:
                c, n = lag_corr(ret_shifted, x, y, lag)
                if np.isfinite(c):
                    null_rows.append((x, y, lag, c, n))
    real = pd.DataFrame(real_rows, columns=["x", "y", "lag", "corr", "n"])
    null = pd.DataFrame(null_rows, columns=["x", "y", "lag", "corr", "n"])
    return real, null


def main():
    print("Screening each league for cross-currency lead-lag correlation (real pairs vs a time-shifted null):\n")
    per_league, per_league_null = {}, {}
    for lg in LEAGUES:
        print(f"  {lg}:")
        ret = load_returns(lg)
        real, null = screen_league(ret)
        per_league[lg] = real
        per_league_null[lg] = null
        if len(real) == 0:
            print(f"    (too few currencies/days to screen - {lg} only ran 21 days - skipping)\n")
            continue
        ra, na = real["corr"].abs().values, null["corr"].abs().values
        print(f"    real |corr|:   mean {ra.mean():.4f}  p95 {np.quantile(ra, 0.95):.4f}  max {ra.max():.4f}  (n={len(ra):,})")
        print(f"    null |corr|:   mean {na.mean():.4f}  p95 {np.quantile(na, 0.95):.4f}  max {na.max():.4f}  (n={len(na):,})")
        # subsample the null to match the real sample size for a fair two-sample test (null has n_null_shifts x more rows)
        na_sub = np.random.default_rng(0).choice(na, size=min(len(na), len(ra)), replace=False)
        ks_stat, ks_p = ks_2samp(ra, na_sub)
        mw_stat, mw_p = mannwhitneyu(ra, na_sub, alternative="greater")
        print(f"    KS test (real vs shifted-null |corr| distributions differ?): D={ks_stat:.4f}, p={ks_p:.2e}")
        print(f"    Mann-Whitney (real |corr| stochastically GREATER than null?): p={mw_p:.2e}")
        top = real.reindex(real["corr"].abs().sort_values(ascending=False).index).head(5)
        print(f"    top 5 pairs (x leads y by `lag` days):")
        for _, r in top.iterrows():
            print(f"      {r.x:28s} -> {r.y:28s}  lag={int(r.lag)}  corr={r['corr']:+.3f}  n={int(r.n)}")
        print()

    # Out-of-sample check, run IDENTICALLY on real pairs and on the shifted-null pairs: take whichever pair+lags
    # look strongest (|corr| > 0.15, present in >= 3 of the 4 training leagues) pooled over
    # Settlers/Mercenaries/Keepers/Phrecia, then check the sign on held-out Mirage. If cross-currency structure
    # is real, the REAL pairs should replicate sign far more often than the NULL pairs do under the exact same
    # "pick the biggest, then check out-of-sample" procedure - the null tells us the replication rate we'd see
    # from pure multiple-comparisons luck alone, which is the honest baseline (not 50%: even noise correlations
    # picked for being large tend to correlate somewhat with their own sign due to selection, so the right
    # comparison is real-vs-null under identical selection, not real-vs-a-coin-flip).
    print("=== Out-of-sample sign replication: REAL pairs vs the SAME procedure applied to the time-shifted NULL ===")
    train_leagues = [l for l in LEAGUES if l != "Mirage" and l in per_league and len(per_league[l]) > 0]
    print(f"(pooling training leagues: {train_leagues})")

    def replication_rate(per_lg, per_lg_null_or_real, holdout_source):
        pooled = pd.concat([per_lg[l].assign(league=l) for l in train_leagues], ignore_index=True)
        agg = pooled.groupby(["x", "y", "lag"]).agg(mean_corr=("corr", "mean"), n=("corr", "size")).reset_index()
        strong = agg[(agg.mean_corr.abs() > 0.15) & (agg.n >= 3)]
        if len(strong) == 0:
            return None, 0
        holdout = holdout_source.groupby(["x", "y", "lag"])["corr"].mean()
        strong = strong.copy()
        strong["holdout_corr"] = strong.apply(lambda r: holdout.get((r.x, r.y, r.lag), np.nan), axis=1)
        strong = strong.dropna(subset=["holdout_corr"])
        if len(strong) == 0:
            return None, 0
        same_sign = (np.sign(strong.mean_corr) == np.sign(strong.holdout_corr)).mean()
        return same_sign, len(strong)

    real_rate, real_n = replication_rate(per_league, None, per_league["Mirage"])
    null_rate, null_n = replication_rate(per_league_null, None, per_league_null["Mirage"])
    print(f"REAL pairs: {real_n} pair+lag combos survived selection; same-sign rate on held-out Mirage: "
          f"{real_rate*100:.0f}%" if real_rate is not None else "REAL: no pairs survived selection")
    print(f"NULL pairs (time-shifted, so any economic link is destroyed): {null_n} combos survived; "
          f"same-sign rate on held-out Mirage: {null_rate*100:.0f}%" if null_rate is not None else "NULL: no pairs survived selection")
    if real_rate is not None and null_rate is not None:
        print(f"\n=> REAL exceeds NULL by {(real_rate-null_rate)*100:+.0f} points. "
              f"{'This is the number that matters, not the 50% coin-flip comparison.' if abs(real_rate-null_rate) > 0.05 else '(small/no gap: no evidence of real cross-currency structure beyond multiple-comparisons noise)'}")


if __name__ == "__main__":
    main()
