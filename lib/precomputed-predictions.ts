import "server-only";
import type { FlipSuggestion, PredictionCurvePoint } from "./flip-suggestions";
import {
  reconstructAllFlipSuggestions,
  isPrecomputedPredictions,
  type PrecomputedItem,
  type PrecomputedPredictions,
} from "./predicted-suggestion";

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
// The file itself only changes once a day, but kept short (not e.g. lib/poe-ninja.ts's 20-minute
// window) so that once the daily job (.github/workflows/precompute-predictions.yml) publishes a new
// day's file, an already-warm serverless instance picks it up quickly instead of continuing to serve
// yesterday's cached (and so day-mismatched -> live-fallback-triggering, see fetchValidPrecomputed
// below) copy for up to a further 20 minutes on top of however late the job itself ran. A shorter TTL
// here just means slightly more (free, public) GitHub requests, not a correctness issue either way.
const CACHE_TTL_MS = 2 * 60 * 1000;

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

/** Fetches the cached file and checks it's actually usable for TODAY's (league, currentDay) - the
 *  job only ever computes against "today", so a wrong league or stale league-day means the file is
 *  from before today's cache window rolled over (or hasn't run yet at all). Shared by every exported
 *  function below so this check can't drift between them. */
async function fetchValidPrecomputed(league: string, currentDay: number): Promise<PrecomputedPredictions | undefined> {
  const data = await fetchPrecomputed();
  if (!data || data.league !== league || data.currentDay !== currentDay) return undefined;
  return data;
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
  const data = await fetchValidPrecomputed(league, currentDay);
  // item.name is already display-formatted (buildSuggestion() ran formatItemDisplayName() before
  // scripts/precompute-predictions.ts ever saw the row), so no re-formatting is needed here.
  return reconstructAllFlipSuggestions(data, durationDays);
}

/**
 * The raw precomputed file, validated for TODAY's (league, currentDay) exactly like
 * getPrecomputedFlipSuggestions above, but not reconstructed into any one duration - backs
 * app/api/flip-suggestions/precomputed/route.ts, which ships the whole thing to the browser ONCE so
 * components/flip-suggestions-panel.tsx can reconstruct every duration locally (via
 * lib/predicted-suggestion.ts's reconstructAllFlipSuggestions) with zero further network round-trips,
 * including while the "Days ahead" slider is being dragged - see that component for why that matters.
 * Undefined on the same terms as every other function here (stale/missing file) - the panel already
 * falls back to its normal per-duration fetch in that case, same as if this endpoint didn't exist.
 */
export async function getPrecomputedPredictionsFile(
  league: string,
  currentDay: number
): Promise<PrecomputedPredictions | undefined> {
  return fetchValidPrecomputed(league, currentDay);
}

/**
 * One item's predicted price at EVERY precomputed duration, straight from the cached file - the fast
 * path for the price history chart's detailed day-by-day forecast line (see
 * components/price-history-chart.tsx's predictedCurve prop and
 * lib/flip-suggestions.ts's getLiveFlipSuggestionCurve for the live fallback this backs off to).
 * Undefined on the same terms as getPrecomputedFlipSuggestions above (stale file, no file, league/day
 * mismatch) or if this specific item isn't in the file at all (e.g. it wasn't priceable at any
 * horizon today - see scripts/precompute-predictions.ts for how that can happen).
 *
 * The item lookup tries the caller's own `category` first, then falls back to matching on
 * historyName/variant alone - lib/flip-suggestions.ts's own comment on the poe.ninja category
 * migration (Scarabs/Essences/Fossils/Oils/Omens/Resonators/Tattoos/Delirium Orbs/Divination Cards)
 * explains why: this file stores each item under whichever category it was ingested as ("item" for
 * every one of those types), but a divination card's own detail page/table row (Divination Card
 * Flips, Currency Exchange Flip) always requests category "currency" to match its live price. Before
 * this fallback, that exact-match `.find()` NEVER matched for any of those items, so this always
 * returned undefined here - not just a missed fast path, but the actual severe bug: the caller
 * (app/api/flip-suggestion-curve/route.ts) then fell all the way to getLiveFlipSuggestionCurve,
 * which reruns the full cross-sectional prediction for the ENTIRE catalog once per duration (30
 * durations, so 30x the normal per-request cost) - EVERY single time ANY divination card's detail
 * page loaded, which is exactly the "whole app frozen, fans spinning" symptom reported live.
 */
export async function getPrecomputedPredictionCurve(
  league: string,
  currentDay: number,
  category: "currency" | "item",
  historyName: string,
  variant: string | undefined
): Promise<PredictionCurvePoint[] | undefined> {
  const data = await fetchValidPrecomputed(league, currentDay);
  if (!data) return undefined;
  const matches = (it: PrecomputedItem) => it.historyName === historyName && (it.variant ?? "") === (variant ?? "");
  const item = data.items.find((it) => it.category === category && matches(it)) ?? data.items.find(matches);
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
