import "server-only";
import { buildFlipRationale, type FlipSuggestion, type PredictionCurvePoint } from "./flip-suggestions";
import type { PredictorMode } from "./prediction-model";

/**
 * Reads today's flip suggestions from a small file a scheduled GitHub Actions job publishes once a
 * day to this repo's "data" branch (see scripts/precompute-predictions.ts and
 * .github/workflows/precompute-predictions.yml), instead of running the model live on every request.
 *
 * This exists purely to cut request latency: the expensive part (growth-ratio SQL + the learned
 * model, roughly 0.7-1s per "Days ahead" value) already ran once, offline, with nobody waiting on it.
 * See ml/README.md's "Whole-trend-line forecasting" section for why that per-request cost isn't
 * safely approximable away instead, especially in a league's first few days.
 *
 * The "data" branch is deliberately never deployed (see vercel.json's git.deploymentEnabled) - this
 * app's committed database is ~72MB, and a Vercel deployment re-bundles the WHOLE app regardless of
 * how small the actual change was, so a daily commit that triggered a real deployment would burn
 * through deployment storage for no reason. Instead this fetches the branch's raw file content
 * directly over HTTP, the same way lib/poe-ninja.ts fetches poe.ninja's prices, with a similar
 * in-memory cache.
 *
 * Never throws - a missing file (the workflow hasn't run yet, or hasn't been set up at all on a
 * fork), a network error, or a stale/wrong-league/wrong-day payload all just resolve to `undefined`,
 * so the caller falls back to computing live, exactly like this file didn't exist.
 */

// Defaults to this project's own repo/branch - override via PREDICTIONS_REPO only if you've forked
// this project and set up your own scheduled job publishing to your own "data" branch; otherwise a
// fork simply always falls back to computing live, which is correct (there's nothing wrong with that
// path - see the module doc above).
const DEFAULT_REPO = "WesleySZhang/poe-flipper";
const DATA_BRANCH = "data";
const DATA_FILE_PATH = "predictions.json";
const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
// The file itself only changes once a day, but this mirrors lib/poe-ninja.ts's cache window for
// consistency - a shorter TTL here just means slightly more (free, public) GitHub requests, not a
// correctness issue either way.
const CACHE_TTL_MS = 20 * 60 * 1000;

/**
 * One item's stored fields - column-per-field, one entry per duration in the file's top-level
 * `durations` list (see scripts/precompute-predictions.ts's module doc for why this is columnar
 * rather than a duplicated FlipSuggestion[] per duration: the naive version was 225MB).
 */
interface PrecomputedItem {
  name: string;
  historyName: string;
  variant?: string;
  category: "currency" | "item";
  filterCategory: string;
  faustusTradeable: boolean;
  predictor: PredictorMode;
  currentChaosValue: number;
  currentDivineValue: number | null;
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

interface PrecomputedPredictions {
  league: string;
  currentDay: number;
  generatedAt: string;
  durations: number[];
  items: PrecomputedItem[];
}

function isPrecomputedPredictions(value: unknown): value is PrecomputedPredictions {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.league === "string" &&
    typeof v.currentDay === "number" &&
    Array.isArray(v.durations) &&
    Array.isArray(v.items)
  );
}

interface CacheEntry {
  // null = fetched but unusable (missing/malformed) - still cached, so a broken file doesn't get
  // re-fetched on every single request within the TTL window.
  data: PrecomputedPredictions | null;
  expiresAt: number;
}
let cache: CacheEntry | undefined;

function rawUrl(): string {
  const repo = process.env.PREDICTIONS_REPO ?? DEFAULT_REPO;
  return `https://raw.githubusercontent.com/${repo}/${DATA_BRANCH}/${DATA_FILE_PATH}`;
}

async function fetchPrecomputed(): Promise<PrecomputedPredictions | null> {
  if (cache && cache.expiresAt > Date.now()) return cache.data;

  let data: PrecomputedPredictions | null = null;
  try {
    const res = await fetch(rawUrl(), { headers: { "User-Agent": USER_AGENT } });
    if (res.ok) {
      const parsed: unknown = await res.json();
      if (isPrecomputedPredictions(parsed)) data = parsed;
    }
  } catch {
    // Network error / malformed JSON - data stays null, caller falls back to a live computation.
  }

  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

/** Rebuilds one FlipSuggestion from an item's stored columns at duration index `i` - the inverse of
 *  scripts/precompute-predictions.ts's accumulation. Returns undefined if this item has no usable
 *  row at that exact horizon (a null slot - the item wasn't priceable/trend-matched there). */
function reconstruct(item: PrecomputedItem, i: number, durationDays: number): FlipSuggestion | undefined {
  const avgGrowthRatio = item.r[i];
  const leagueCount = item.lc[i];
  const baselineGrowthRatio = item.br[i];
  if (avgGrowthRatio === null || leagueCount === null || baselineGrowthRatio === null) return undefined;

  const avgGrowthRatioDivine = item.rd[i] ?? undefined;
  const currentDivineValue = item.currentDivineValue ?? undefined;
  return {
    name: item.name,
    historyName: item.historyName,
    variant: item.variant,
    category: item.category,
    filterCategory: item.filterCategory,
    faustusTradeable: item.faustusTradeable,
    currentChaosValue: item.currentChaosValue,
    currentDivineValue,
    predictedChaosValue: item.currentChaosValue * avgGrowthRatio,
    predictedDivineValue: currentDivineValue !== undefined && avgGrowthRatioDivine !== undefined ? currentDivineValue * avgGrowthRatioDivine : undefined,
    avgGrowthRatio,
    avgGrowthRatioDivine,
    leagueCount,
    leagueCountDivine: item.lcd[i] ?? leagueCount,
    confidence: item.cf[i] ?? 0,
    confidenceDivine: item.cfd[i] ?? undefined,
    upFraction: item.uf[i] ?? 0,
    upFractionDivine: item.ufd[i] ?? undefined,
    rationale: buildFlipRationale(item.predictor, avgGrowthRatio, baselineGrowthRatio, leagueCount, durationDays),
    baselineGrowthRatio,
    baselineGrowthRatioDivine: item.brd[i] ?? undefined,
    predictor: item.predictor,
    forecastSpread: item.fs[i] ?? undefined,
  };
}

/**
 * Today's precomputed suggestions for one (league, currentDay, durationDays), or undefined if
 * there's no usable match - a stale file (wrong league or league day, since the job only ever
 * computes against "today"), a duration the job didn't cover, or no file at all. The caller should
 * fall back to lib/flip-suggestions.ts's getFlipSuggestions in every one of those cases.
 */
export async function getPrecomputedFlipSuggestions(
  league: string,
  currentDay: number,
  durationDays: number
): Promise<FlipSuggestion[] | undefined> {
  const data = await fetchPrecomputed();
  if (!data || data.league !== league || data.currentDay !== currentDay) return undefined;
  const i = data.durations.indexOf(durationDays);
  if (i === -1) return undefined;

  // item.name is already display-formatted (buildSuggestion() ran formatItemDisplayName() before
  // scripts/precompute-predictions.ts ever saw the row), so no re-formatting is needed here.
  const suggestions: FlipSuggestion[] = [];
  for (const item of data.items) {
    const s = reconstruct(item, i, durationDays);
    if (s) suggestions.push(s);
  }
  return suggestions.sort((a, b) => b.avgGrowthRatio - a.avgGrowthRatio);
}

/**
 * One item's predicted price at EVERY precomputed duration, straight from the cached file - the fast
 * path for the price history chart's detailed day-by-day forecast line (see
 * components/price-history-chart.tsx's predictedCurve prop and
 * lib/flip-suggestions.ts's getLiveFlipSuggestionCurve for the live fallback this backs off to).
 * Undefined on the same terms as getPrecomputedFlipSuggestions above (stale file, no file, league/day
 * mismatch) or if this specific item isn't in the file at all (e.g. it wasn't priceable at any
 * horizon today - see scripts/precompute-predictions.ts for how that can happen).
 */
export async function getPrecomputedPredictionCurve(
  league: string,
  currentDay: number,
  category: "currency" | "item",
  historyName: string,
  variant: string | undefined
): Promise<PredictionCurvePoint[] | undefined> {
  const data = await fetchPrecomputed();
  if (!data || data.league !== league || data.currentDay !== currentDay) return undefined;
  const item = data.items.find(
    (it) => it.category === category && it.historyName === historyName && (it.variant ?? "") === (variant ?? "")
  );
  if (!item) return undefined;

  return data.durations.map((durationDays, i) => {
    const ratio = item.r[i];
    const ratioDivine = item.rd[i];
    return {
      durationDays,
      predictedChaosValue: ratio === null ? null : item.currentChaosValue * ratio,
      predictedDivineValue:
        ratioDivine === null || item.currentDivineValue === null ? null : item.currentDivineValue * ratioDivine,
    };
  });
}
