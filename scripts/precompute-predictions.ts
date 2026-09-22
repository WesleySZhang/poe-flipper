/**
 * Computes flip suggestions for every "Days ahead" value the UI's numeric input meaningfully
 * supports (1-30 - see MAX_DURATION_DAYS below) against TODAY's real league day, and writes them to
 * predictions.json at the repo root. A scheduled GitHub Actions workflow
 * (.github/workflows/precompute-predictions.yml) runs this once a day and publishes the result to
 * this repo's "data" branch; lib/precomputed-predictions.ts reads it from there at request time
 * instead of recomputing live - see that file's module doc for why (and vercel.json for why that
 * branch never triggers a Vercel deployment).
 *
 * Reuses getFlipSuggestions() completely unchanged, once per horizon - NOT any of the whole-
 * trend-line approximations explored in ml/README.md's "Whole-trend-line forecasting" section. A
 * background job has no per-request latency budget, so there's no reason to trade any accuracy for
 * speed here: every horizon gets the real, exact model call. 30 sequential calls take under a
 * minute (roughly 0.7-1s each once poe.ninja's cache and the DB connection are warm) - trivial for a
 * job nobody is waiting on, unlike doing this on every page load.
 *
 * OUTPUT FORMAT is deliberately columnar, not "FlipSuggestion[] per duration" - an early version did
 * that and produced a 225MB file (30 horizons x ~10k rows each, with every item's name/category/etc.
 * AND a full English rationale sentence repeated on every single row - the rationale text alone
 * accounted for the majority of it). Per item, the fields that don't depend on durationDays
 * (name, category, today's live price, ...) are stored once; only the handful of numbers that
 * genuinely vary by horizon (the ratio, confidence, league count, ...) are stored as one array per
 * field, index-aligned with the top-level `durations` list. lib/precomputed-predictions.ts
 * reconstructs a normal FlipSuggestion[] from this at read time - see that file for the reverse
 * mapping and for why the rationale sentence itself isn't stored at all (buildFlipRationale()
 * recomputes it from the same handful of stored numbers).
 *
 * Not part of the running app - this only ever runs offline (locally for a dry run, or in CI).
 * Run:  npx tsx --conditions=react-server scripts/precompute-predictions.ts
 *       (the react-server condition lets this script import files that use the "server-only" package)
 */
import fs from "node:fs";
import path from "node:path";
import { getFlipSuggestions, type FlipSuggestion } from "../lib/flip-suggestions";
import { currentLeagueDay } from "../lib/league-day";
import { CURRENT_LEAGUE, CURRENT_LEAGUE_START_DATE } from "../lib/league-recency";

const MIN_DURATION_DAYS = 1;
// Matches the learned model's trained/validated range (see ml/README.md) - the UI's numeric input
// allows larger values too, but those already fall outside the model's own scope and always compute
// live today; there's nothing meaningful to precompute past this point.
const MAX_DURATION_DAYS = 30;
const OUTPUT_PATH = path.join(__dirname, "..", "predictions.json");

// A forecast is never meaningfully precise to more than a handful of significant figures - rounding
// before serializing shrinks the file without losing anything a person or the ranking logic cares
// about (mirrors the same rounding scripts/_trend_dump.ts used during the backtest work).
function r5(v: number | undefined): number | null {
  return v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1e5) / 1e5;
}

/** One item's horizon-INVARIANT fields, keyed so items can be matched up across every duration's
 *  FlipSuggestion[] (name+variant+category is unique - the same key lib/poe-ninja.ts's itemPriceKey
 *  and this app's other per-item maps already use). */
function itemKey(s: FlipSuggestion): string {
  return `${s.category}|${s.historyName}|${s.variant ?? ""}`;
}

async function main() {
  const currentDay = currentLeagueDay(CURRENT_LEAGUE_START_DATE);
  const durations: number[] = [];
  for (let d = MIN_DURATION_DAYS; d <= MAX_DURATION_DAYS; d++) durations.push(d);

  // Keyed accumulators - filled in duration order below, so every array ends up index-aligned with
  // `durations`.
  interface Accum {
    name: string;
    historyName: string;
    variant?: string;
    category: "currency" | "item";
    filterCategory: string;
    faustusTradeable: boolean;
    predictor: string;
    currentChaosValue: number;
    currentDivineValue: number | null;
    r: (number | null)[]; // avgGrowthRatio
    rd: (number | null)[]; // avgGrowthRatioDivine
    lc: (number | null)[]; // leagueCount
    lcd: (number | null)[]; // leagueCountDivine
    cf: (number | null)[]; // confidence
    cfd: (number | null)[]; // confidenceDivine
    uf: (number | null)[]; // upFraction
    ufd: (number | null)[]; // upFractionDivine
    br: (number | null)[]; // baselineGrowthRatio
    brd: (number | null)[]; // baselineGrowthRatioDivine
    fs: (number | null)[]; // forecastSpread
  }
  const byKey = new Map<string, Accum>();

  const nullRow = () => ({ r: null, rd: null, lc: null, lcd: null, cf: null, cfd: null, uf: null, ufd: null, br: null, brd: null, fs: null }) as const;

  for (let di = 0; di < durations.length; di++) {
    const durationDays = durations[di];
    const suggestions = await getFlipSuggestions(CURRENT_LEAGUE, currentDay, durationDays);
    // An empty result almost certainly means poe.ninja (or the DB) failed silently, not that there
    // are genuinely zero flippable items - refuse to publish that rather than let it look real.
    if (suggestions.length === 0) {
      throw new Error(`getFlipSuggestions returned 0 rows for durationDays=${durationDays} - refusing to publish a suspicious/empty result.`);
    }

    const seenThisDuration = new Set<string>();
    for (const s of suggestions) {
      const key = itemKey(s);
      seenThisDuration.add(key);
      let acc = byKey.get(key);
      if (!acc) {
        // First time this item has shown up in any duration processed so far - backfill `di` null
        // entries first, so every array below stays index-aligned with `durations` even though this
        // item wasn't priceable/trend-matched (see ml/README.md's "confidence drift" finding) at any
        // earlier horizon this run already looped past.
        const blanks = nullRow();
        acc = {
          name: s.name,
          historyName: s.historyName,
          variant: s.variant,
          category: s.category,
          filterCategory: s.filterCategory,
          faustusTradeable: s.faustusTradeable,
          predictor: s.predictor,
          currentChaosValue: s.currentChaosValue,
          currentDivineValue: s.currentDivineValue ?? null,
          r: new Array(di).fill(blanks.r), rd: new Array(di).fill(blanks.rd),
          lc: new Array(di).fill(blanks.lc), lcd: new Array(di).fill(blanks.lcd),
          cf: new Array(di).fill(blanks.cf), cfd: new Array(di).fill(blanks.cfd),
          uf: new Array(di).fill(blanks.uf), ufd: new Array(di).fill(blanks.ufd),
          br: new Array(di).fill(blanks.br), brd: new Array(di).fill(blanks.brd),
          fs: new Array(di).fill(blanks.fs),
        };
        byKey.set(key, acc);
      }
      acc.r.push(r5(s.avgGrowthRatio));
      acc.rd.push(r5(s.avgGrowthRatioDivine));
      acc.lc.push(s.leagueCount);
      acc.lcd.push(s.leagueCountDivine);
      acc.cf.push(r5(s.confidence));
      acc.cfd.push(r5(s.confidenceDivine));
      acc.uf.push(r5(s.upFraction));
      acc.ufd.push(r5(s.upFractionDivine));
      acc.br.push(r5(s.baselineGrowthRatio));
      acc.brd.push(r5(s.baselineGrowthRatioDivine));
      acc.fs.push(r5(s.forecastSpread));
    }
    // An item that HAD shown up in an earlier duration but not this one still needs a null slot here
    // (rather than just skipping it), so its arrays stay the same length as `durations` for every
    // item, regardless of which horizons it happened to be priceable/trend-matched at.
    for (const [key, acc] of byKey) {
      if (seenThisDuration.has(key)) continue;
      acc.r.push(null); acc.rd.push(null); acc.lc.push(null); acc.lcd.push(null);
      acc.cf.push(null); acc.cfd.push(null); acc.uf.push(null); acc.ufd.push(null);
      acc.br.push(null); acc.brd.push(null); acc.fs.push(null);
    }
    process.stdout.write(`  day ${currentDay} +${durationDays}d: ${suggestions.length} rows (${byKey.size} distinct items so far)\r`);
  }

  const payload = {
    league: CURRENT_LEAGUE,
    currentDay,
    generatedAt: new Date().toISOString(),
    durations,
    items: Array.from(byKey.values()),
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload));
  console.log(`\nWrote ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(1)} MB, ${byKey.size} items x ${durations.length} horizons)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
