/**
 * Is the shipped 5-league training set leaving prediction quality on the table? scripts/
 * ingest-history.ts restricts training to the last handful of leagues, on the reasoning that older
 * leagues are noisier and that league-recency weighting discounts them anyway - but production has
 * since moved to FLAT weighting (see lib/league-recency.ts), so that second half no longer holds.
 *
 * Meanwhile scripts/discover-error-budget.ts showed the item effect is only ~24% of horizon-ratio
 * variance and the shipped model captures well under half of it, with the gap being estimation
 * noise on an average of ~4 leagues. More training leagues attack that noise directly - and since
 * peer shrinkage (scripts/discover-peer-shrinkage.ts) is fundamentally a SUBSTITUTE for having more
 * data, this also measures whether the two are complements or redundant.
 *
 * CONCLUSION: rejected - keep the 5-league training set. Adding the 12 unused leagues looks like a
 * win only when results are pooled across all holdouts, and that pooling is misleading. Ordered by
 * holdout recency, the effect is monotonic in the HOLDOUT's own age, not in training-set size:
 *   Settlers (oldest holdout)  Pearson 0.375 -> 0.494   big gain
 *   Mercenaries                        0.388 -> 0.484   big gain
 *   Keepers                            0.388 -> 0.347   loss, monotonic as leagues are added
 *   Phrecia 2.0                        0.316 -> 0.274   loss, monotonic
 *   Mirage (newest holdout)            0.314 -> 0.282   loss
 * The extra leagues are contemporaries of the OLD holdouts, so they help predict those and stale
 * out the recent ones. On the three recent holdouts alone - the regime production actually predicts
 * against - no arm beats the shipped 5 leagues on Pearson or MAE, and "all 17" drops directional
 * accuracy from 64% to 59%. A 6-8 league set is a wash (+1pp direction, worse Pearson and MAE).
 *
 * Two practical costs confirm the call: the DB grows 69MB -> 225MB (it ships via Git LFS and
 * deploys to Vercel), and ingest-history.ts's spike-correction pass OOMs at Node's default 4GB
 * heap on 22.7M item rows, so it would need bounding per-league first.
 *
 * This also refines lib/league-recency.ts's flat-weighting result rather than contradicting it:
 * recency genuinely doesn't matter much AMONG leagues within ~2 years of each other, but leagues
 * 2-6 years back are a different economy, not just a noisier sample of the same one.
 *
 * Peer shrinkage survives all of it - on recent holdouts it improves MAE 0.4096 -> 0.3839 and
 * directional accuracy 64% -> 67% at every training-set size, so it is not a substitute for data
 * we could have had instead.
 *
 * Always run against an experimental DB built with extra leagues, never the shipped one:
 *   POE_DB_PATH=/tmp/history-all.duckdb POE_INCLUDED_LEAGUES="Affliction,Ancestor,..." \
 *     NODE_OPTIONS=--max-old-space-size=24576 npx tsx scripts/ingest-history.ts
 *   POE_DB_PATH=/tmp/history-all.duckdb npx tsx scripts/discover-training-leagues.ts
 */
import { getDb } from "../lib/db";

const TOL = 3;
const MIN_TRAIN_LEAGUES = 3; // matches production MIN_LEAGUES_WITH_DATA
const SHRINK_W = 0.5; // best flat weight from discover-peer-shrinkage.ts
const SCENARIOS: Array<[number, number]> = [
  [0, 7],
  [4, 7],
  [7, 7],
  [7, 14],
  [10, 10],
  [14, 7],
  [4, 14],
];
// Scored on the leagues production already trains on, so these numbers stay directly comparable to
// the baseline in discover-peer-shrinkage.ts. Extra leagues only ever enter as TRAINING data.
const PRODUCTION_LEAGUES = ["Mirage", "Keepers", "Mercenaries", "Settlers", "Phrecia 2.0"];

// Release order, newest first - only used to build "N most recent" training subsets below, so
// approximate dates are fine. Kept here rather than in lib/league-recency.ts, which deliberately
// only carries leagues production actually ingests.
const LEAGUE_ORDER = [
  "Mirage",
  "Phrecia 2.0",
  "Keepers",
  "Mercenaries",
  "Phrecia",
  "Settlers",
  "Necropolis",
  "Affliction",
  "Ancestor",
  "Crucible",
  "Archnemesis",
  "Expedition",
  "Ultimatum",
  "Ritual",
  "Heist",
  "Harvest",
  "Metamorph",
];

// The app always predicts the CURRENT league, so a training set that helps on old holdouts but
// hurts on recent ones is a regression for the actual use case. These are the three most recent
// completed leagues - the holdouts that actually resemble what production predicts against.
const RECENT_HOLDOUTS = ["Mirage", "Phrecia 2.0", "Keepers"];

interface Obs {
  scenario: number;
  league: string;
  key: string;
  category: string;
  v: number;
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

interface Acc {
  p: number[];
  a: number[];
  trainLeaguesPerItem: number[];
}
const newAcc = (): Acc => ({ p: [], a: [], trainLeaguesPerItem: [] });

/** One evaluation arm: which leagues may be used as training data for a given holdout. */
interface Arm {
  label: string;
  trainingPool: (holdout: string) => string[];
}

/** A fitted training set for one (arm, holdout, scenario): everything needed to score a test row. */
interface Fit {
  grand: number;
  itemD: Map<string, number>;
  catD: Map<string, number>;
  nLeagues: Map<string, number>;
}

function fit(train: Obs[]): Fit {
  const leagueMean = groupMean(train, (r) => r.league, (r) => r.v);
  const demeaned = train.map((r) => ({ ...r, d: r.v - (leagueMean.get(r.league) ?? 0) }));
  const counts = new Map<string, Set<string>>();
  for (const r of train) {
    const set = counts.get(r.key) ?? new Set<string>();
    set.add(r.league);
    counts.set(r.key, set);
  }
  return {
    grand: mean(train.map((r) => r.v)),
    itemD: groupMean(demeaned, (r) => r.key, (r) => r.d),
    catD: groupMean(demeaned, (r) => r.category, (r) => r.d),
    nLeagues: new Map(Array.from(counts, ([k, s]) => [k, s.size])),
  };
}

/**
 * Scores every arm on exactly the same test rows. Necessary because a bigger training pool lets
 * MORE items clear the >=3-league filter - so scoring each arm over whatever it happens to cover
 * would compare them on different, non-comparable row sets. Coverage is reported separately, since
 * "more items become predictable at all" is a real benefit in its own right.
 */
function evaluateArms(obs: Obs[], arms: Arm[], holdouts: string[]) {
  // Per arm, per holdout, keeping the raw and shrunk predictions separate so main() can pool over
  // any subset of holdouts (all five, or only the recent ones that resemble production's target).
  const perHoldout = arms.map(() => new Map<string, { plain: Acc; shrunk: Acc }>());
  const coverage = arms.map(() => 0);
  let pairedRows = 0;

  for (const holdout of holdouts) {
    const ph = arms.map(() => ({ plain: newAcc(), shrunk: newAcc() }));
    for (let s = 0; s < SCENARIOS.length; s++) {
      const test = obs.filter((o) => o.scenario === s && o.league === holdout);
      if (test.length < 50) continue;
      const fits = arms.map((arm) => {
        const pool = new Set(arm.trainingPool(holdout));
        const train = obs.filter((o) => o.scenario === s && pool.has(o.league));
        return train.length < 50 ? undefined : fit(train);
      });
      if (fits.some((f) => f === undefined)) continue;

      for (const t of test) {
        const usable = fits.map((f) => {
          const nL = f!.nLeagues.get(t.key) ?? 0;
          const iD = f!.itemD.get(t.key);
          return nL >= MIN_TRAIN_LEAGUES && iD !== undefined ? { nL, iD } : undefined;
        });
        usable.forEach((u, i) => {
          if (u) coverage[i]++;
        });
        if (usable.some((u) => u === undefined)) continue;
        pairedRows++;
        usable.forEach((u, i) => {
          const f = fits[i]!;
          const cD = f.catD.get(t.category) ?? 0;
          ph[i].plain.p.push(f.grand + u!.iD);
          ph[i].plain.a.push(t.v);
          ph[i].plain.trainLeaguesPerItem.push(u!.nL);
          ph[i].shrunk.p.push(f.grand + SHRINK_W * u!.iD + (1 - SHRINK_W) * cD);
          ph[i].shrunk.a.push(t.v);
        });
      }
    }
    ph.forEach((acc, i) => perHoldout[i].set(holdout, acc));
  }
  return { perHoldout, coverage, pairedRows };
}

function mergeAcc(accs: Acc[]): Acc {
  const out = newAcc();
  for (const a of accs) {
    out.p.push(...a.p);
    out.a.push(...a.a);
    out.trainLeaguesPerItem.push(...a.trainLeaguesPerItem);
  }
  return out;
}

function row(label: string, acc: Acc) {
  if (acc.p.length === 0) return { variant: label, n: 0 };
  return {
    variant: label,
    n: acc.p.length,
    pearson_log: pearson(acc.p, acc.a).toFixed(3),
    MAE_log: mean(acc.p.map((x, i) => Math.abs(x - acc.a[i]))).toFixed(4),
    "dir%": Math.round((acc.p.filter((x, i) => x >= 0 === acc.a[i] >= 0).length / acc.p.length) * 100),
    "avg train leagues/item": acc.trainLeaguesPerItem.length
      ? mean(acc.trainLeaguesPerItem).toFixed(2)
      : "-",
  };
}

async function main() {
  const db = await getDb();
  const leagueRows = await db.runAndReadAll("SELECT DISTINCT league FROM item_history_dayed ORDER BY league");
  const available = leagueRows.getRowObjects().map((r) => String(r.league));
  console.log(`Leagues in this DB (${available.length}): ${available.join(", ")}`);

  const holdouts = PRODUCTION_LEAGUES.filter((l) => available.includes(l));
  console.log(`Scoring on holdouts: ${holdouts.join(", ")}\n`);

  const obs = await fetchHorizon();
  console.log(`horizon observations: ${obs.length}\n`);

  // Intermediate arms matter: "all 17" conflates "older leagues are a different economy" with
  // "we diluted 4 good leagues with 12". Walking the count out by recency separates the two.
  const mostRecent = (n: number) => LEAGUE_ORDER.filter((l) => available.includes(l)).slice(0, n);
  const arms: Arm[] = [
    {
      label: "production 5",
      trainingPool: (h) => PRODUCTION_LEAGUES.filter((l) => l !== h && available.includes(l)),
    },
    { label: "6 most recent", trainingPool: (h) => mostRecent(6).filter((l) => l !== h) },
    { label: "8 most recent", trainingPool: (h) => mostRecent(8).filter((l) => l !== h) },
    { label: "12 most recent", trainingPool: (h) => mostRecent(12).filter((l) => l !== h) },
    { label: `all ${available.length}`, trainingPool: (h) => available.filter((l) => l !== h) },
  ];

  const { perHoldout, coverage, pairedRows } = evaluateArms(obs, arms, holdouts);
  const pool = (i: number, hs: string[], which: "plain" | "shrunk") =>
    mergeAcc(hs.map((h) => perHoldout[i].get(h)?.[which] ?? newAcc()));

  console.log(`=== Coverage: test rows each arm can predict at all (>=${MIN_TRAIN_LEAGUES} training leagues) ===`);
  console.table(
    arms.map((arm, i) => ({
      arm: arm.label,
      "predictable rows": coverage[i],
      "vs production": `${(((coverage[i] - coverage[0]) / coverage[0]) * 100).toFixed(1)}%`,
    }))
  );

  const recent = RECENT_HOLDOUTS.filter((h) => holdouts.includes(h));

  console.log(`\n=== ALL ${holdouts.length} holdouts, ${pairedRows} paired rows (apples to apples) ===`);
  console.table(
    arms.flatMap((arm, i) => [
      row(`${arm.label} (raw)`, pool(i, holdouts, "plain")),
      row(`${arm.label} + shrink w=${SHRINK_W}`, pool(i, holdouts, "shrunk")),
    ])
  );

  console.log(`\n=== RECENT holdouts only (${recent.join(", ")}) - the regime production predicts ===`);
  console.table(
    arms.flatMap((arm, i) => [
      row(`${arm.label} (raw)`, pool(i, recent, "plain")),
      row(`${arm.label} + shrink w=${SHRINK_W}`, pool(i, recent, "shrunk")),
    ])
  );

  console.log("\n=== Per-holdout, raw item mean - ordered newest holdout first ===");
  console.table(
    LEAGUE_ORDER.filter((h) => holdouts.includes(h)).flatMap((holdout) =>
      arms.map((arm, i) => ({ holdout, ...row(arm.label, perHoldout[i].get(holdout)?.plain ?? newAcc()) }))
    )
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
