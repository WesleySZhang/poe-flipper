/**
 * The branches scheduled jobs publish generated data to - read back by the app from
 * raw.githubusercontent.com. Each is written by one job only, force-pushed as a single fresh commit
 * (latest files, no history), and never deployed (vercel.json's git.deploymentEnabled). The
 * workflows spell the names out too: .github/workflows/precompute-predictions.yml and
 * scripts/publish-sold-tracker.sh (called by track-sold-listings.yml).
 */

/** "Precompute predictions" (daily): predictions.json, prices.json, history/<League>/*.csv. */
export const PRECOMPUTE_DATA_BRANCH = "precompute-data";

/** "Track sold listings" (every 6 hours): state/, sold-listings/, ended/. */
export const SOLD_TRACKER_DATA_BRANCH = "sold-tracker-data";
