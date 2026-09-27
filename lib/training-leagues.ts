/**
 * The finished leagues the model learns from: scripts/ingest-history.ts builds db/history.duckdb from
 * exactly these, and scripts/export-training-features.ts exports a training run per league.
 *
 * Restricting to the last handful of leagues trades away data volume for data quality: older leagues'
 * price history is noisier and a different economy (scripts/discover-training-leagues.ts tested adding
 * the 12 older ones and rejected it). Phrecia 2.0 is a short event league but its data passes the
 * ingest's sanity checks; plain "Phrecia" (the original event) stays out.
 *
 * Every league here also needs a release date in lib/league-recency.ts (growth ratios only read leagues
 * listed there). The "Retrain model" workflow edits this list (scripts/retrain-leagues.ts), so keep it
 * one array of plain strings.
 */
export const TRAINING_LEAGUES: readonly string[] = ["Mirage", "Phrecia 2.0", "Keepers", "Mercenaries", "Settlers"];
