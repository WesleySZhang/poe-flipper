/**
 * Backtests the shipped predictor on the CURRENT league's own collected prices: replays "now" = each
 * collected league day, rebuilds what the live app would have seen (price now, the 7-day sparkline,
 * past-league growth ratios for that day and horizon), predicts with each predictor, then scores the
 * predictions against the price the current league actually reached `durationDays` later.
 *
 * Out-of-sample by construction: the current league isn't in db/history.duckdb (growth ratios) or
 * the model's training leagues (lib/training-leagues.ts). Inputs are causal (lib/history-now.ts:
 * "now" and the sparkline never look past the replayed day).
 *
 *   npx tsx --conditions=react-server scripts/backtest-current-league.ts [--step 3] [--min-chaos 1] [--out report.json]
 *
 * Reads the daily CSVs scripts/precompute-price-history.ts collects on the precompute-data branch
 * (`git fetch origin precompute-data` first). Only days since collection began can be replayed
 * (Allflame: from 2026-09-21, league day ~59), so this measures late-league accuracy only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { getCurrencyGrowthRatios, getItemGrowthRatios } from "../lib/growth-ratios";
import { historyNowAtDay, valueAtOrBefore, valueNearest, type DailySeries, type LeagueDailyMatrix } from "../lib/history-now";
import { CURRENT_LEAGUE, CURRENT_LEAGUE_START_DATE } from "../lib/league-recency";
import { itemPriceKey } from "../lib/poe-ninja";
import type { PredictionInput } from "../lib/prediction-features";
import { predictGrowth, resolveMode, type PredictorMode } from "../lib/prediction-model";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const STEP = Number(arg("step", "3"));
const MIN_CHAOS = Number(arg("min-chaos", "1"));
const OUT = arg("out", "");
// Every scored row of the production predictor as CSV (day,duration,group,priceNow,pred,act; log ratios), for
// ml/late_league_calibration.py.
const ROWS_OUT = arg("rows-out", "");
const DURATIONS = [1, 3, 7, 14, 30];
// The future price may be a day off when a collection day was missed; "now" never looks forward.
const FUTURE_TOLERANCE_DAYS = 1;
const DAY_MS = 86_400_000;

function dayOffset(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${CURRENT_LEAGUE_START_DATE}T00:00:00Z`)) / DAY_MS);
}

/** Same rules as lib/current-league-history.ts: currency priced in chaos; item rows sharing a key and
 *  day (one poe.ninja line per item level/influence) are averaged. */
function loadMatrix(): LeagueDailyMatrix {
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "origin/precompute-data", "--", `history/${CURRENT_LEAGUE}/`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f.endsWith(".csv"));
  const read = (f: string) => execFileSync("git", ["show", `origin/precompute-data:${f}`], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const cur = new Map<string, Map<number, number>>();
  const itm = new Map<string, { type?: string; days: Map<number, { sum: number; n: number }> }>();
  let maxDay = 0;
  for (const f of files) {
    const lines = read(f).split(/\r?\n/);
    const isCurrency = f.includes(".currency.");
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const c = lines[i].split(";");
      const day = dayOffset(c[1]);
      maxDay = Math.max(maxDay, day);
      if (isCurrency) {
        const [, , get, pay, value] = c;
        const v = Number(value);
        if (pay !== "Chaos Orb" || get === "Chaos Orb" || !Number.isFinite(v)) continue;
        (cur.get(get) ?? cur.set(get, new Map()).get(get)!).set(day, v);
      } else {
        const [, , , type, name, , variant, , value] = c;
        const v = Number(value);
        if (!Number.isFinite(v)) continue;
        const key = itemPriceKey(name, variant || undefined);
        const e = itm.get(key) ?? itm.set(key, { type, days: new Map() }).get(key)!;
        const acc = e.days.get(day) ?? { sum: 0, n: 0 };
        acc.sum += v;
        acc.n++;
        e.days.set(day, acc);
      }
    }
  }
  const size = maxDay + 1;
  const series = (days: Map<number, number>, type?: string): DailySeries => {
    const values = new Float64Array(size).fill(NaN);
    for (const [d, v] of days) values[d] = v;
    return { values, type };
  };
  const currency = new Map([...cur].map(([k, d]) => [k, series(d)]));
  const items = new Map(
    [...itm].map(([k, e]) => [k, series(new Map([...e.days].map(([d, { sum, n }]) => [d, sum / n])), e.type)])
  );
  const divineRate = currency.get("Divine Orb")?.values ?? new Float64Array(size).fill(NaN);
  return { league: CURRENT_LEAGUE, maxDay, currency, items, divineRate };
}

function ranks(v: number[]): number[] {
  const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
  const r = new Array<number>(v.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
    for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function spearman(a: number[], b: number[]): number {
  const ra = ranks(a), rb = ranks(b), n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n, mb = rb.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

interface Row {
  key: string;
  kind: "currency" | "item";
  /** Scored separately: base types average several poe.ninja lines (one per item level/influence), so
   *  their daily price jumps when a line appears or goes (TODO.md item 3). */
  group: "currency" | "base type" | "other item";
  day: number;
  duration: number;
  priceNow: number;
  pred: number; // log predicted ratio
  act: number; // log actual ratio
}

interface Score {
  n: number;
  rho: number;
  /** Rows that moved more than 5% either way: share where the predicted direction was right. */
  direction: number;
  /** Top 10% by prediction: mean actual log return, and share that rose. */
  topMean: number;
  topMedian: number;
  topUp: number;
  /** Everything's mean actual log return - what the top picks have to beat. */
  allMean: number;
  /** Median |log error|, model vs predicting no change. */
  mae: number;
  maeFlat: number;
}

function score(rows: Row[]): Score {
  const moved = rows.filter((r) => Math.abs(r.act) > Math.log(1.05));
  const top = [...rows].sort((a, b) => b.pred - a.pred).slice(0, Math.max(5, Math.floor(rows.length * 0.1)));
  return {
    n: rows.length,
    rho: spearman(rows.map((r) => r.pred), rows.map((r) => r.act)),
    direction: moved.filter((r) => Math.sign(r.pred) === Math.sign(r.act)).length / moved.length,
    topMean: mean(top.map((r) => r.act)),
    topMedian: median(top.map((r) => r.act)),
    topUp: top.filter((r) => r.act > 0).length / top.length,
    allMean: mean(rows.map((r) => r.act)),
    mae: median(rows.map((r) => Math.abs(r.pred - r.act))),
    maeFlat: median(rows.map((r) => Math.abs(r.act))),
  };
}

async function main() {
  console.log(`Loading ${CURRENT_LEAGUE} history from origin/precompute-data...`);
  const matrix = loadMatrix();
  const firstDay = Math.min(
    ...[...matrix.currency.values()].map((s) => s.values.findIndex((v) => Number.isFinite(v))).filter((d) => d >= 0)
  );
  console.log(`${matrix.currency.size} currencies, ${matrix.items.size} items, league days ${firstDay}-${matrix.maxDay}`);

  const production = resolveMode(process.env.PREDICTOR);
  const modes: Array<[string, PredictorMode]> = [
    [`production (${production})`, production],
    ...(production !== "formula" ? ([["formula", "formula"]] as Array<[string, PredictorMode]>) : []),
    ["past-league average", "baseline"],
  ];
  const rows: Record<string, Row[]> = Object.fromEntries(modes.map(([n]) => [n, []]));

  // The sparkline needs 6 days before "now", so start a week into collection.
  for (let day = firstDay + 6; day < matrix.maxDay; day += STEP) {
    const now = historyNowAtDay(matrix, day);
    for (const duration of DURATIONS) {
      const target = day + duration;
      if (target > matrix.maxDay) continue;
      const [currencyTrends, itemTrends] = await Promise.all([
        getCurrencyGrowthRatios({ currentDay: day, durationDays: duration }),
        getItemGrowthRatios({ currentDay: day, durationDays: duration }),
      ]);
      const inputs: PredictionInput[] = [];
      const meta: Array<{ kind: "currency" | "item"; group: Row["group"]; key: string; priceNow: number; future: number }> = [];
      for (const [kind, trends] of [["currency", currencyTrends], ["item", itemTrends]] as const) {
        const pool = kind === "currency" ? matrix.currency : matrix.items;
        const nowMap = kind === "currency" ? now.currency : now.items;
        for (const trend of trends) {
          const key = kind === "currency" ? trend.name : itemPriceKey(trend.name, trend.variant);
          const s = pool.get(key);
          if (!s) continue;
          const priceNow = valueAtOrBefore(s.values, day, 1);
          if (!(priceNow > 0)) continue;
          const hist = nowMap.get(key);
          inputs.push({
            key,
            kind,
            ratio: trend,
            priceNow,
            divineRateNow: now.divineRateNow,
            spark: hist?.spark,
          });
          meta.push({ kind, group: kind === "currency" ? "currency" : s.type === "BaseType" ? "base type" : "other item", key, priceNow, future: valueNearest(s.values, target, FUTURE_TOLERANCE_DAYS) });
        }
      }
      const universe = [...currencyTrends, ...itemTrends];
      for (const [name, mode] of modes) {
        const preds = predictGrowth(inputs, { currentDay: day, durationDays: duration, universe }, mode);
        preds.forEach((p, i) => {
          const m = meta[i];
          if (!(m.future > 0) || m.priceNow < MIN_CHAOS || !(p.ratio > 0)) return;
          rows[name].push({ key: m.key, kind: m.kind, group: m.group, day, duration, priceNow: m.priceNow, pred: Math.log(p.ratio), act: Math.log(m.future / m.priceNow) });
        });
      }
      process.stdout.write(`  day ${day} +${duration}d (${inputs.length} items)          \r`);
    }
  }
  console.log("");

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const ret = (x: number) => `${x >= 0 ? "+" : ""}${((Math.exp(x) - 1) * 100).toFixed(1)}%`;
  const report: Record<string, unknown> = {};
  for (const group of ["currency", "other item", "base type"] as const) {
    console.log(`\n=== ${group} (priced >= ${MIN_CHAOS}c), mean over replayed days ===`);
    console.log("horizon  predictor                   n/day   Spearman  direction  top-10% avg  top-10% median  all avg   top-10% up  median err  no-change err");
    for (const duration of DURATIONS) {
      for (const [name] of modes) {
        const byDay = new Map<number, Row[]>();
        for (const r of rows[name]) if (r.group === group && r.duration === duration) (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
        const scores = [...byDay.values()].filter((r) => r.length >= 30).map(score);
        if (!scores.length) continue;
        const avg = (f: (s: Score) => number) => mean(scores.map(f).filter(Number.isFinite));
        const s = { n: avg((x) => x.n), rho: avg((x) => x.rho), direction: avg((x) => x.direction), topMean: avg((x) => x.topMean), topMedian: avg((x) => x.topMedian), allMean: avg((x) => x.allMean), topUp: avg((x) => x.topUp), mae: avg((x) => x.mae), maeFlat: avg((x) => x.maeFlat) };
        (report[`${group} +${duration}d ${name}`] = { ...s, days: scores.length });
        console.log(
          `+${String(duration).padEnd(2)}d    ${name.padEnd(26)} ${String(Math.round(s.n)).padStart(6)}   ${s.rho.toFixed(3).padStart(7)}   ${pct(s.direction).padStart(8)}   ${ret(s.topMean).padStart(10)}   ${ret(s.topMedian).padStart(12)}  ${ret(s.allMean).padStart(7)}   ${pct(s.topUp).padStart(9)}   ${ret(s.mae).padStart(9)}   ${ret(s.maeFlat).padStart(11)}`
        );
      }
    }
  }

  // Concrete calls: the production model's strongest predicted risers at +7d, and what happened.
  const prodName = modes[0][0];
  for (const duration of [7, 14]) {
    const calls = rows[prodName].filter((r) => r.duration === duration && r.priceNow >= 5 && r.group !== "base type");
    const best = [...calls].sort((a, b) => b.pred - a.pred).slice(0, 25);
    const hits = best.filter((r) => r.act > 0).length;
    console.log(`\nStrongest predicted risers at +${duration}d (priced >= 5c, base types left out, all replayed days): ${hits}/${best.length} rose`);
    for (const r of best.slice(0, 15)) {
      console.log(`  day ${r.day}  ${r.key.slice(0, 48).padEnd(48)} ${r.priceNow.toFixed(1).padStart(9)}c  predicted ${ret(r.pred).padStart(8)}  actual ${ret(r.act).padStart(8)}`);
    }
    const right = calls.filter((r) => r.pred > Math.log(1.2) && r.act > Math.log(1.2)).sort((a, b) => b.act - a.act);
    console.log(`  Predicted +20% or more and rose +20% or more: ${right.length} of ${calls.filter((r) => r.pred > Math.log(1.2)).length} such predictions`);
    for (const r of right.slice(0, 8)) {
      console.log(`    day ${r.day}  ${r.key.slice(0, 46).padEnd(46)} ${r.priceNow.toFixed(1).padStart(9)}c  predicted ${ret(r.pred).padStart(8)}  actual ${ret(r.act).padStart(8)}`);
    }
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  if (ROWS_OUT) {
    const lines = rows[prodName].map((r) => `${r.day},${r.duration},${r.group},${r.priceNow},${r.pred},${r.act}`);
    fs.writeFileSync(ROWS_OUT, ["day,duration,group,priceNow,pred,act", ...lines].join("\n") + "\n");
  }
}

main().then(() => { process.exitCode = 0; }).catch((e) => { console.error(e); process.exitCode = 1; });
