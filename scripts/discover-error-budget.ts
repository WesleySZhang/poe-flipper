/**
 * Where does the flip model's prediction error actually live? Splits the variance of horizon
 * log-ratios into league / category / item / residual, then runs leave-one-league-out (every league
 * as holdout, not just Mirage) to see how much of the per-item signal generalizes.
 *
 * Findings from the run that motivated the peer-shrinkage work (chaos / divine):
 *   - league factor  0.8% / 1.2%  - the whole economy moving together explains almost nothing at
 *     horizon scale (SD across leagues only ~0.05 log). An ORACLE told the holdout's true league
 *     factor gains just ~0.02 Pearson, so "nowcast how hot this league is" has no headroom. That is
 *     consistent with the separately-rejected current-league momentum signal (branch trend-momentum).
 *   - category      2.6% / 2.6%
 *   - item         23.9% / 21.0%  - the signal the shipped model actually exploits.
 *   - residual     72.7% / 75.2%  - idiosyncratic and unpredictable from any structure at this
 *     granularity. This is a hard ceiling: even a perfect item-effect estimate caps Pearson near
 *     sqrt(0.24) ~ 0.49, against ~0.35 today. The gap is estimation noise on a 4-league average,
 *     which is exactly what shrinking toward a peer group buys back.
 *
 * Run: npx tsx scripts/discover-error-budget.ts
 */
import { getDb } from "../lib/db";

const TOL = 3;
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

interface Obs {
  league: string;
  key: string;
  category: string;
  logR: number;
  logRDiv?: number;
}

async function fetchScenario(currentDay: number, durationDays: number): Promise<Obs[]> {
  const db = await getDb();
  const targetDay = currentDay + durationDays;
  const params = { currentDay, targetDay, tol: TOL };
  const rateJoin = "LEFT JOIN divine_rate_dayed dr ON dr.league = d.league AND dr.day_offset = d.day_offset";

  const itemSql = `
    WITH nn AS (
      SELECT d.league, d.name, d.variant, d.type, d.value AS v_now, dr.chaos_per_divine AS r_now,
             ROW_NUMBER() OVER (PARTITION BY d.league, d.name, d.variant ORDER BY ABS(d.day_offset - $currentDay)) AS rn
      FROM item_history_dayed d ${rateJoin}
      WHERE d.day_offset BETWEEN $currentDay - $tol AND $currentDay + $tol
    ), nf AS (
      SELECT d.league, d.name, d.variant, d.value AS v_fut, dr.chaos_per_divine AS r_fut,
             ROW_NUMBER() OVER (PARTITION BY d.league, d.name, d.variant ORDER BY ABS(d.day_offset - $targetDay)) AS rn
      FROM item_history_dayed d ${rateJoin}
      WHERE d.day_offset BETWEEN $targetDay - $tol AND $targetDay + $tol
    )
    SELECT n.league, n.name, n.variant, n.type AS category, n.v_now, f.v_fut, n.r_now, f.r_fut
    FROM nn n JOIN nf f ON n.league = f.league AND n.name = f.name AND n.variant IS NOT DISTINCT FROM f.variant
    WHERE n.rn = 1 AND f.rn = 1 AND n.v_now >= 1 AND f.v_fut > 0`;

  const currSql = `
    WITH nn AS (
      SELECT d.league, d.name, d.value AS v_now, dr.chaos_per_divine AS r_now,
             ROW_NUMBER() OVER (PARTITION BY d.league, d.name ORDER BY ABS(d.day_offset - $currentDay)) AS rn
      FROM currency_history_dayed d ${rateJoin}
      WHERE d.day_offset BETWEEN $currentDay - $tol AND $currentDay + $tol
    ), nf AS (
      SELECT d.league, d.name, d.value AS v_fut, dr.chaos_per_divine AS r_fut,
             ROW_NUMBER() OVER (PARTITION BY d.league, d.name ORDER BY ABS(d.day_offset - $targetDay)) AS rn
      FROM currency_history_dayed d ${rateJoin}
      WHERE d.day_offset BETWEEN $targetDay - $tol AND $targetDay + $tol
    )
    SELECT n.league, n.name, NULL AS variant, 'Currency' AS category, n.v_now, f.v_fut, n.r_now, f.r_fut
    FROM nn n JOIN nf f ON n.league = f.league AND n.name = f.name
    WHERE n.rn = 1 AND f.rn = 1 AND n.v_now >= 0.02 AND f.v_fut > 0`;

  const [itemR, currR] = await Promise.all([
    db.runAndReadAll(itemSql, params),
    db.runAndReadAll(currSql, params),
  ]);

  const out: Obs[] = [];
  for (const row of [...itemR.getRowObjects(), ...currR.getRowObjects()]) {
    const vNow = Number(row.v_now);
    const vFut = Number(row.v_fut);
    if (!(vNow > 0) || !(vFut > 0)) continue;
    const variant = row.variant ? String(row.variant) : "";
    const rNow = Number(row.r_now);
    const rFut = Number(row.r_fut);
    const divOk = Number.isFinite(rNow) && rNow > 0 && Number.isFinite(rFut) && rFut > 0;
    out.push({
      league: String(row.league),
      key: `${String(row.name)}::${variant}`,
      category: row.category ? String(row.category) : "Unknown",
      logR: Math.log(vFut / vNow),
      logRDiv: divOk ? Math.log(vFut / rFut / (vNow / rNow)) : undefined,
    });
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
};
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
function groupMean<T>(rows: T[], keyOf: (r: T) => string, valOf: (r: T) => number): Map<string, number> {
  const acc = new Map<string, { s: number; n: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    const cur = acc.get(k) ?? { s: 0, n: 0 };
    cur.s += valOf(r);
    cur.n += 1;
    acc.set(k, cur);
  }
  return new Map(Array.from(acc, ([k, v]) => [k, v.s / v.n]));
}

/** Sequential ANOVA-style split of log-ratio variance: league factor, then category, then item. */
function decompose(obs: Obs[], pick: (o: Obs) => number | undefined) {
  const rows = obs.flatMap((o) => {
    const v = pick(o);
    return v !== undefined && Number.isFinite(v) ? [{ ...o, v }] : [];
  });
  if (rows.length < 50) return undefined;
  const grand = mean(rows.map((r) => r.v));
  const total = variance(rows.map((r) => r.v));

  const leagueMean = groupMean(rows, (r) => r.league, (r) => r.v);
  const afterLeague = rows.map((r) => ({ ...r, d: r.v - (leagueMean.get(r.league) ?? grand) }));
  const leagueShare = 1 - variance(afterLeague.map((r) => r.d)) / total;

  const catMean = groupMean(afterLeague, (r) => r.category, (r) => r.d);
  const afterCat = afterLeague.map((r) => ({ ...r, d2: r.d - (catMean.get(r.category) ?? 0) }));
  const catShare = (variance(afterLeague.map((r) => r.d)) - variance(afterCat.map((r) => r.d2))) / total;

  const itemMean = groupMean(afterCat, (r) => r.key, (r) => r.d2);
  const resid = afterCat.map((r) => r.d2 - (itemMean.get(r.key) ?? 0));
  const itemShare = (variance(afterCat.map((r) => r.d2)) - variance(resid)) / total;

  return {
    n: rows.length,
    totalSd: Math.sqrt(total),
    leagueShare,
    catShare,
    itemShare,
    residShare: variance(resid) / total,
    leagueSpread: Math.sqrt(variance(Array.from(leagueMean.values()))),
  };
}

/** Leave-one-league-out: does the per-item estimate generalize, and does peer shrinkage help? */
function loloTest(obs: Obs[], pick: (o: Obs) => number | undefined, weights: number[]) {
  const rows = obs.flatMap((o) => {
    const v = pick(o);
    return v !== undefined && Number.isFinite(v) ? [{ ...o, v }] : [];
  });
  const preds: Record<string, { p: number[]; a: number[] }> = {};
  const add = (label: string, p: number, a: number) => {
    preds[label] ??= { p: [], a: [] };
    preds[label].p.push(p);
    preds[label].a.push(a);
  };
  const oracle: { p: number[]; a: number[] } = { p: [], a: [] };

  for (const holdout of LEAGUES) {
    const train = rows.filter((r) => r.league !== holdout);
    const test = rows.filter((r) => r.league === holdout);
    if (train.length < 50 || test.length < 50) continue;
    const trainLeagueMean = groupMean(train, (r) => r.league, (r) => r.v);
    const trainDemeaned = train.map((r) => ({ ...r, d: r.v - (trainLeagueMean.get(r.league) ?? 0) }));
    const itemCount = new Map<string, number>();
    for (const r of train) itemCount.set(r.key, (itemCount.get(r.key) ?? 0) + 1);
    // Raw per-item mean (what the model ships today) and the peer-group mean, both league-demeaned.
    const itemMeanRaw = groupMean(train, (r) => r.key, (r) => r.v);
    const itemMeanD = groupMean(trainDemeaned, (r) => r.key, (r) => r.d);
    const catMeanD = groupMean(trainDemeaned, (r) => r.category, (r) => r.d);
    const trainGrand = mean(train.map((r) => r.v));
    const testLeagueMean = mean(test.map((r) => r.v));

    for (const t of test) {
      const nLeagues = itemCount.get(t.key) ?? 0;
      if (nLeagues < 2) continue;
      const raw = itemMeanRaw.get(t.key);
      if (raw === undefined) continue;
      add("item mean (current model)", raw, t.v);
      add("category mean only", trainGrand + (catMeanD.get(t.category) ?? 0), t.v);
      const iD = itemMeanD.get(t.key) ?? 0;
      const cD = catMeanD.get(t.category) ?? 0;
      for (const w of weights) {
        add(`shrink w=${w.toFixed(2)}`, trainGrand + w * iD + (1 - w) * cD, t.v);
      }
      // Oracle: same per-item signal, but told the holdout's true league-wide factor.
      oracle.p.push(testLeagueMean + iD);
      oracle.a.push(t.v);
    }
  }
  const rowsOut = Object.entries(preds).map(([label, { p, a }]) => ({
    variant: label,
    n: p.length,
    pearson_log: pearson(p, a).toFixed(3),
    MAE_log: mean(p.map((x, i) => Math.abs(x - a[i]))).toFixed(4),
    "dir%": Math.round((p.filter((x, i) => x >= 0 === a[i] >= 0).length / p.length) * 100),
  }));
  if (oracle.p.length > 0) {
    rowsOut.push({
      variant: "ORACLE: item + true league factor",
      n: oracle.p.length,
      pearson_log: pearson(oracle.p, oracle.a).toFixed(3),
      MAE_log: mean(oracle.p.map((x, i) => Math.abs(x - oracle.a[i]))).toFixed(4),
      "dir%": Math.round((oracle.p.filter((x, i) => x >= 0 === oracle.a[i] >= 0).length / oracle.p.length) * 100),
    });
  }
  return rowsOut;
}

async function main() {
  const all: Obs[] = [];
  for (const [d, dur] of SCENARIOS) {
    const obs = await fetchScenario(d, dur);
    all.push(...obs);
    console.log(`scenario day ${d} -> +${dur}d: ${obs.length} (league,item) observations`);
  }
  console.log(`\nPooled: ${all.length} observations\n`);

  for (const [label, pick] of [
    ["CHAOS", (o: Obs) => o.logR],
    ["DIVINE", (o: Obs) => o.logRDiv],
  ] as const) {
    const dec = decompose(all, pick);
    if (!dec) continue;
    console.log(`=== ${label}: variance decomposition of horizon log-ratio ===`);
    console.table([
      {
        n: dec.n,
        "total SD (log)": dec.totalSd.toFixed(3),
        "league factor %": (dec.leagueShare * 100).toFixed(1),
        "category %": (dec.catShare * 100).toFixed(1),
        "item %": (dec.itemShare * 100).toFixed(1),
        "residual %": (dec.residShare * 100).toFixed(1),
        "SD across leagues": dec.leagueSpread.toFixed(3),
      },
    ]);
  }

  const weights = [0, 0.25, 0.5, 0.75, 1];
  for (const [label, pick] of [
    ["CHAOS", (o: Obs) => o.logR],
    ["DIVINE", (o: Obs) => o.logRDiv],
  ] as const) {
    console.log(`\n=== ${label}: leave-one-league-out generalization ===`);
    console.table(loloTest(all, pick, weights));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
