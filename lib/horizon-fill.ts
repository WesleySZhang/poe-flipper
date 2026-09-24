/**
 * Fills the horizons where the model had no row for an item, so every item that has any prediction
 * gets one for every "Days ahead" in the precomputed file. The model needs at least
 * MIN_LEAGUES_WITH_DATA past leagues with a price near BOTH today and the target day
 * (lib/growth-ratios.ts); one past league with a hole in its data drops a whole stretch of horizons
 * for the item (see the "The Last One Standing" gap at 19-28 days). Pure and environment-agnostic,
 * run by scripts/precompute-predictions.ts on each item's columns before they're written.
 *
 * Filled values are estimates and are marked (`e`) and given lower confidence:
 *  - interpolated (e=1): a gap between two real horizons, or before the first one. Log-linear between
 *    the neighbors, anchored at ratio 1 for "0 days ahead" when there is no earlier neighbor.
 *  - extended (e=2): past the last real horizon. Holds that last ratio flat (no growth beyond what
 *    the data supports), so it's the weakest estimate.
 * Real rows are never touched.
 */

export const INTERPOLATED_CONFIDENCE_FACTOR = 0.75;
export const EXTENDED_CONFIDENCE_FACTOR = 0.5;

export type Estimate = 0 | 1 | 2;

/** The per-horizon columns of one precomputed item that get filled - see PrecomputedItem. */
export interface FillableColumns {
  r: (number | null)[];
  rd: (number | null)[];
  lc: (number | null)[];
  lcd: (number | null)[];
  cf: (number | null)[];
  cfd: (number | null)[];
  uf: (number | null)[];
  ufd: (number | null)[];
  br: (number | null)[];
  brd: (number | null)[];
  fs: (number | null)[];
}

function logInterp(a: number | null, b: number | null, t: number): number | null {
  if (a === null || b === null || a <= 0 || b <= 0) return null;
  return Math.exp((1 - t) * Math.log(a) + t * Math.log(b));
}

function round5(v: number | null): number | null {
  return v === null ? null : Math.round(v * 1e5) / 1e5;
}

function minOf(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : Math.min(a, b);
}

function scaled(v: number | null, factor: number): number | null {
  return v === null ? null : Math.round(v * factor);
}

/** Fills `cols` in place; returns which horizons were estimated (all 0 if nothing needed filling). */
export function fillHorizonGaps(cols: FillableColumns, durations: number[]): Estimate[] {
  const n = durations.length;
  const estimate: Estimate[] = new Array(n).fill(0);
  const known: number[] = [];
  for (let i = 0; i < n; i++) if (cols.r[i] !== null) known.push(i);
  if (known.length === 0 || known.length === n) return estimate;

  for (let i = 0; i < n; i++) {
    if (cols.r[i] !== null) continue;
    let prev: number | undefined;
    let next: number | undefined;
    for (const k of known) {
      if (k < i) prev = k;
      else if (k > i) {
        next = k;
        break;
      }
    }

    if (next !== undefined) {
      // Between two real horizons, or before the first (then the "previous" point is ratio 1 at 0 days).
      const t = prev !== undefined
        ? (durations[i] - durations[prev]) / (durations[next] - durations[prev])
        : durations[i] / durations[next];
      const a = (col: (number | null)[]) => (prev !== undefined ? col[prev] : 1);
      cols.r[i] = round5(logInterp(a(cols.r), cols.r[next], t));
      cols.rd[i] = round5(logInterp(a(cols.rd), cols.rd[next], t));
      cols.br[i] = round5(logInterp(a(cols.br), cols.br[next], t));
      cols.brd[i] = round5(logInterp(a(cols.brd), cols.brd[next], t));
      const src = prev !== undefined && t < 0.5 ? prev : next;
      cols.uf[i] = cols.uf[src];
      cols.ufd[i] = cols.ufd[src];
      cols.fs[i] = cols.fs[src];
      cols.lc[i] = prev !== undefined ? minOf(cols.lc[prev], cols.lc[next]) : cols.lc[next];
      cols.lcd[i] = prev !== undefined ? minOf(cols.lcd[prev], cols.lcd[next]) : cols.lcd[next];
      cols.cf[i] = scaled(prev !== undefined ? minOf(cols.cf[prev], cols.cf[next]) : cols.cf[next], INTERPOLATED_CONFIDENCE_FACTOR);
      cols.cfd[i] = scaled(prev !== undefined ? minOf(cols.cfd[prev], cols.cfd[next]) : cols.cfd[next], INTERPOLATED_CONFIDENCE_FACTOR);
      estimate[i] = 1;
    } else if (prev !== undefined) {
      // Past the last real horizon: hold it.
      for (const key of ["r", "rd", "lc", "lcd", "uf", "ufd", "br", "brd", "fs"] as const) cols[key][i] = cols[key][prev];
      cols.cf[i] = scaled(cols.cf[prev], EXTENDED_CONFIDENCE_FACTOR);
      cols.cfd[i] = scaled(cols.cfd[prev], EXTENDED_CONFIDENCE_FACTOR);
      estimate[i] = 2;
    }
  }
  return estimate;
}
