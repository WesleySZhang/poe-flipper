/**
 * Does shrinking each item's noisy 4-league average toward a PEER GROUP beat using it raw, and does
 * a learned correlation peer group beat poe.ninja's crude type bucket? Correlations come from daily
 * log-return co-movement in the training leagues only, cross-sectionally demeaned per day so they
 * measure relative co-movement rather than everything drifting up with chaos inflation together.
 * Strictly leave-one-league-out, under production's >=3-training-league filter.
 *
 * Findings from the run that motivated this work (367k pooled rows, all 5 leagues as holdout):
 *   - Shrinking toward the CATEGORY mean at w~0.4-0.5 clearly beats the raw item mean:
 *     MAE(log) 0.3824 -> 0.3516 (-8%), directional accuracy 65% -> 68%, Pearson flat (0.346 ->
 *     0.343). Adaptive weights (empirical-Bayes n/(n+k), or spread-based) match but do not beat it,
 *     so a flat weight is preferred for simplicity.
 *   - Learned correlation peers reach only 12.4% of test rows (the liquid universe), so the pooled
 *     table mostly compares category against itself. On the covered subset, apples to apples: as a
 *     STANDALONE predictor they carry roughly twice category's signal (Pearson 0.226 vs 0.116), and
 *     combining both peer signals gives the best directional accuracy (84%, vs 83% category-only and
 *     76% baseline) - but category shrinkage still wins on MAE (0.2869 vs 0.3018), because a
 *     20-neighbour estimate is lower-bias / higher-variance than pooling a whole category.
 *     Conclusion: correlation peers are real but unproven as a replacement - worth pursuing only as
 *     a complement to category shrinkage, and only once coverage improves.
 *
 * Run: npx tsx scripts/discover-peer-shrinkage.ts
 */
import { getDb } from "../lib/db";

const TOL = 3;
const MAX_CORR_DAY = 45;
const UNIVERSE_SIZE = 1200;
const MIN_COVERAGE = 0.6;
const TOP_K = 20;
const SCENARIOS: Array<[number, number]> = [
  [0, 7],
  [4, 7],
  [7, 7],
  [7, 14],
  [10, 10],
  [14, 7],
  [4, 14],
];
const LEAGUES = ["Mirage", "Keepers", "Mercenaries", "Settlers", "Phrecia 2.0"];
const MIN_TRAIN_LEAGUES = 3; // matches production MIN_LEAGUES_WITH_DATA

interface Obs {
  scenario: number;
  league: string;
  key: string;
  category: string;
  v: number; // horizon log-ratio (chaos)
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let n = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    n += (xs[i] - mx) * (ys[i] - my);
    dx2 += (xs[i] - mx) ** 2;
    dy2 += (ys[i] - my) ** 2;
  }
  return dx2 * dy2 === 0 ? 0 : n / Math.sqrt(dx2 * dy2);
}
function groupMean<T>(rows: T[], k: (r: T) => string, v: (r: T) => number): Map<string, number> {
  const acc = new Map<string, { s: number; n: number }>();
  for (const r of rows) {
    const key = k(r);
    const cur = acc.get(key) ?? { s: 0, n: 0 };
    cur.s += v(r);
    cur.n += 1;
    acc.set(key, cur);
  }
  return new Map(Array.from(acc, ([key, a]) => [key, a.s / a.n]));
}

async function fetchHorizon(): Promise<Obs[]> {
  const db = await getDb();
  const out: Obs[] = [];
  for (let s = 0; s < SCENARIOS.length; s++) {
    const [currentDay, dur] = SCENARIOS[s];
    const params = { currentDay, targetDay: currentDay + dur, tol: TOL };
    const itemSql = `
      WITH nn AS (
        SELECT league, name, variant, type, value AS v_now,
               ROW_NUMBER() OVER (PARTITION BY league, name, variant ORDER BY ABS(day_offset - $currentDay)) AS rn
        FROM item_history_dayed WHERE day_offset BETWEEN $currentDay - $tol AND $currentDay + $tol
      ), nf AS (
        SELECT league, name, variant, value AS v_fut,
               ROW_NUMBER() OVER (PARTITION BY league, name, variant ORDER BY ABS(day_offset - $targetDay)) AS rn
        FROM item_history_dayed WHERE day_offset BETWEEN $targetDay - $tol AND $targetDay + $tol
      )
      SELECT n.league, n.name, n.variant, n.type AS category, n.v_now, f.v_fut
      FROM nn n JOIN nf f ON n.league=f.league AND n.name=f.name AND n.variant IS NOT DISTINCT FROM f.variant
      WHERE n.rn=1 AND f.rn=1 AND n.v_now >= 1 AND f.v_fut > 0`;
    const currSql = `
      WITH nn AS (
        SELECT league, name, value AS v_now,
               ROW_NUMBER() OVER (PARTITION BY league, name ORDER BY ABS(day_offset - $currentDay)) AS rn
        FROM currency_history_dayed WHERE day_offset BETWEEN $currentDay - $tol AND $currentDay + $tol
      ), nf AS (
        SELECT league, name, value AS v_fut,
               ROW_NUMBER() OVER (PARTITION BY league, name ORDER BY ABS(day_offset - $targetDay)) AS rn
        FROM currency_history_dayed WHERE day_offset BETWEEN $targetDay - $tol AND $targetDay + $tol
      )
      SELECT n.league, n.name, NULL AS variant, 'Currency' AS category, n.v_now, f.v_fut
      FROM nn n JOIN nf f ON n.league=f.league AND n.name=f.name
      WHERE n.rn=1 AND f.rn=1 AND n.v_now >= 0.02 AND f.v_fut > 0`;
    const [a, b] = await Promise.all([db.runAndReadAll(itemSql, params), db.runAndReadAll(currSql, params)]);
    for (const row of [...a.getRowObjects(), ...b.getRowObjects()]) {
      const vNow = Number(row.v_now);
      const vFut = Number(row.v_fut);
      if (!(vNow > 0) || !(vFut > 0)) continue;
      out.push({
        scenario: s,
        league: String(row.league),
        key: `${String(row.name)}::${row.variant ? String(row.variant) : ""}`,
        category: row.category ? String(row.category) : "Unknown",
        v: Math.log(vFut / vNow),
      });
    }
  }
  return out;
}

/** Daily price series for a liquid universe, early-league window only. */
async function fetchDaily(): Promise<Map<string, Map<string, Map<number, number>>>> {
  const db = await getDb();
  const sql = `
    WITH u AS (
      SELECT name, variant FROM item_history_dayed WHERE day_offset <= ${MAX_CORR_DAY}
      GROUP BY 1,2 ORDER BY COUNT(*) DESC LIMIT ${UNIVERSE_SIZE}
    )
    SELECT d.league, d.name, d.variant, d.day_offset, d.value
    FROM item_history_dayed d JOIN u ON d.name=u.name AND d.variant IS NOT DISTINCT FROM u.variant
    WHERE d.day_offset <= ${MAX_CORR_DAY} AND d.value > 0
    UNION ALL
    SELECT league, name, NULL AS variant, day_offset, value
    FROM currency_history_dayed WHERE day_offset <= ${MAX_CORR_DAY} AND value > 0`;
  const r = await db.runAndReadAll(sql);
  const byKey = new Map<string, Map<string, Map<number, number>>>();
  for (const row of r.getRowObjects()) {
    const key = `${String(row.name)}::${row.variant ? String(row.variant) : ""}`;
    let leagues = byKey.get(key);
    if (!leagues) {
      leagues = new Map();
      byKey.set(key, leagues);
    }
    const league = String(row.league);
    let days = leagues.get(league);
    if (!days) {
      days = new Map();
      leagues.set(league, days);
    }
    days.set(Number(row.day_offset), Number(row.value));
  }
  return byKey;
}

/** Correlation-based top-K neighbours per key, learned from training leagues only. */
function buildNeighbours(
  daily: Map<string, Map<string, Map<number, number>>>,
  trainLeagues: string[]
): Map<string, Array<{ key: string; corr: number }>> {
  const slots: Array<[string, number]> = [];
  for (const league of trainLeagues) for (let d = 1; d <= MAX_CORR_DAY; d++) slots.push([league, d]);
  const slotIndex = new Map(slots.map(([l, d], i) => [`${l}|${d}`, i]));
  const keys: string[] = [];
  const vectors: Float64Array[] = [];

  for (const [key, leagues] of daily) {
    const vec = new Float64Array(slots.length);
    const present = new Uint8Array(slots.length);
    let count = 0;
    for (const league of trainLeagues) {
      const days = leagues.get(league);
      if (!days) continue;
      for (let d = 1; d <= MAX_CORR_DAY; d++) {
        const prev = days.get(d - 1);
        const cur = days.get(d);
        if (prev === undefined || cur === undefined || prev <= 0 || cur <= 0) continue;
        const i = slotIndex.get(`${league}|${d}`)!;
        vec[i] = Math.log(cur / prev);
        present[i] = 1;
        count++;
      }
    }
    if (count < slots.length * MIN_COVERAGE) continue;
    keys.push(key);
    vectors.push(vec);
  }

  // Remove the per-day cross-sectional mean so correlation measures RELATIVE co-movement rather
  // than everything drifting together with chaos inflation.
  for (let i = 0; i < slots.length; i++) {
    let s = 0;
    for (const v of vectors) s += v[i];
    const m = s / vectors.length;
    for (const v of vectors) v[i] -= m;
  }
  // Standardize so a dot product is the correlation.
  for (const v of vectors) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i];
    const m = s / v.length;
    let ss = 0;
    for (let i = 0; i < v.length; i++) {
      v[i] -= m;
      ss += v[i] * v[i];
    }
    const sd = Math.sqrt(ss) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= sd;
  }

  const neighbours = new Map<string, Array<{ key: string; corr: number }>>();
  for (let i = 0; i < keys.length; i++) {
    const best: Array<{ key: string; corr: number }> = [];
    for (let j = 0; j < keys.length; j++) {
      if (i === j) continue;
      let dot = 0;
      const a = vectors[i];
      const b = vectors[j];
      for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
      if (dot <= 0.1) continue;
      best.push({ key: keys[j], corr: dot });
    }
    best.sort((x, y) => y.corr - x.corr);
    neighbours.set(keys[i], best.slice(0, TOP_K));
  }
  return neighbours;
}

async function main() {
  console.log("Fetching horizon ratios and daily series...");
  const [obs, daily] = await Promise.all([fetchHorizon(), fetchDaily()]);
  console.log(`horizon obs: ${obs.length}, daily universe keys: ${daily.size}\n`);

  const results: Record<string, { p: number[]; a: number[] }> = {};
  const add = (label: string, p: number, a: number) => {
    results[label] ??= { p: [], a: [] };
    results[label].p.push(p);
    results[label].a.push(a);
  };
  // Same accumulator, but only over test rows that actually HAVE correlation neighbours - the
  // pooled table otherwise compares corrPeers against itself (it falls back to category elsewhere).
  const covered: Record<string, { p: number[]; a: number[] }> = {};
  const addCovered = (label: string, p: number, a: number) => {
    covered[label] ??= { p: [], a: [] };
    covered[label].p.push(p);
    covered[label].a.push(a);
  };
  let neighbourCoverage = 0;
  let total = 0;

  for (const holdout of LEAGUES) {
    const trainLeagues = LEAGUES.filter((l) => l !== holdout);
    const neighbours = buildNeighbours(daily, trainLeagues);
    for (let s = 0; s < SCENARIOS.length; s++) {
      const train = obs.filter((o) => o.scenario === s && o.league !== holdout);
      const test = obs.filter((o) => o.scenario === s && o.league === holdout);
      if (train.length < 50 || test.length < 50) continue;
      const leagueMean = groupMean(train, (r) => r.league, (r) => r.v);
      const demeaned = train.map((r) => ({ ...r, d: r.v - (leagueMean.get(r.league) ?? 0) }));
      const grand = mean(train.map((r) => r.v));
      const itemD = groupMean(demeaned, (r) => r.key, (r) => r.d);
      const catD = groupMean(demeaned, (r) => r.category, (r) => r.d);
      const nLeagues = new Map<string, Set<string>>();
      for (const r of train) {
        const set = nLeagues.get(r.key) ?? new Set<string>();
        set.add(r.league);
        nLeagues.set(r.key, set);
      }
      // Per-item disagreement across training leagues - the same "spread" the confidence score
      // already uses, here as a candidate for deciding HOW MUCH to shrink each item.
      const byKey = new Map<string, number[]>();
      for (const r of demeaned) {
        const list = byKey.get(r.key) ?? [];
        list.push(r.d);
        byKey.set(r.key, list);
      }
      const spread = new Map<string, number>();
      for (const [key, xs] of byKey) {
        if (xs.length < 2) continue;
        const m = mean(xs);
        spread.set(key, Math.sqrt(mean(xs.map((x) => (x - m) ** 2))));
      }

      for (const t of test) {
        const nL = nLeagues.get(t.key)?.size ?? 0;
        if (nL < MIN_TRAIN_LEAGUES) continue;
        const iD = itemD.get(t.key);
        if (iD === undefined) continue;
        const cD = catD.get(t.category) ?? 0;
        total++;

        // Peer estimate from correlation neighbours (falls back to category when unavailable).
        let peerD = cD;
        let hasNeighbours = false;
        const nb = neighbours.get(t.key);
        if (nb && nb.length > 0) {
          let ws = 0;
          let acc = 0;
          for (const { key, corr } of nb) {
            const d = itemD.get(key);
            if (d === undefined) continue;
            acc += corr * d;
            ws += corr;
          }
          if (ws > 0) {
            peerD = acc / ws;
            hasNeighbours = true;
            neighbourCoverage++;
          }
        }

        add("item mean (current model)", grand + iD, t.v);
        for (const w of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
          add(`shrink->category w=${w.toFixed(1)}`, grand + w * iD + (1 - w) * cD, t.v);
        }
        // Empirical-Bayes style: shrink harder when the item has fewer training leagues behind it.
        for (const k of [1, 2, 3, 5]) {
          const w = nL / (nL + k);
          add(`adaptive n/(n+${k})`, grand + w * iD + (1 - w) * cD, t.v);
        }
        // Shrink harder when the training leagues disagreed more about this item.
        const sp = spread.get(t.key);
        if (sp !== undefined) {
          for (const s0 of [0.3, 0.5]) {
            const w = 1 / (1 + sp / s0);
            add(`adaptive spread s0=${s0}`, grand + w * iD + (1 - w) * cD, t.v);
          }
        }

        if (hasNeighbours) {
          addCovered("item mean (current model)", grand + iD, t.v);
          addCovered("shrink->category w=0.50", grand + 0.5 * iD + 0.5 * cD, t.v);
          addCovered("shrink->corrPeers w=0.50", grand + 0.5 * iD + 0.5 * peerD, t.v);
          addCovered("shrink->corrPeers w=0.30", grand + 0.3 * iD + 0.7 * peerD, t.v);
          addCovered("category only", grand + cD, t.v);
          addCovered("corrPeers only", grand + peerD, t.v);
          // Both peer signals together, in case they carry different information.
          addCovered("shrink->(cat+peers)/2 w=0.50", grand + 0.5 * iD + 0.5 * ((cD + peerD) / 2), t.v);
        }
      }
    }
  }

  const table = (r: Record<string, { p: number[]; a: number[] }>) =>
    Object.entries(r).map(([label, { p, a }]) => ({
      variant: label,
      n: p.length,
      pearson_log: pearson(p, a).toFixed(3),
      MAE_log: mean(p.map((x, i) => Math.abs(x - a[i]))).toFixed(4),
      "dir%": Math.round((p.filter((x, i) => x >= 0 === a[i] >= 0).length / p.length) * 100),
    }));

  console.log(`neighbour coverage: ${((neighbourCoverage / Math.max(total, 1)) * 100).toFixed(1)}% of test rows\n`);
  console.log(`=== LOLO, production filter (>=${MIN_TRAIN_LEAGUES} training leagues) ===`);
  console.table(table(results));
  console.log(`\n=== Apples-to-apples: ONLY rows that have correlation neighbours ===`);
  console.table(table(covered));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
