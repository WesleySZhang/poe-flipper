/**
 * Edits the training league list (lib/training-leagues.ts) for the "Retrain model" workflow, and picks the
 * validation holdouts for the export.
 *
 *   npx tsx scripts/retrain-leagues.ts [--add "League"] [--drop "League"]    (comma-separate several)
 *
 * Refuses a league that's still running (CURRENT_LEAGUE) or has no release date in lib/league-recency.ts
 * (growth ratios only read leagues listed there), and a set too small for the model's league minimum.
 *
 * Holdouts: the newest training league (the forward-in-time test) plus Mirage while it's in the set, since
 * scripts/backtest-predictor.ts replays Mirage and needs a model trained without it.
 *
 * Writes `leagues`, `holdouts` and `changed` to GITHUB_OUTPUT when set.
 */
import fs from "node:fs";
import path from "node:path";
import { MIN_LEAGUES_WITH_DATA } from "../lib/growth-ratios";
import { CURRENT_LEAGUE, leagueReleaseDate } from "../lib/league-recency";
import { SIMULATED_LEAGUE } from "../lib/mirage-league";
import { TRAINING_LEAGUES } from "../lib/training-leagues";

const FILE = path.join(__dirname, "..", "lib", "training-leagues.ts");
const LIST_RE = /export const TRAINING_LEAGUES: readonly string\[\] = \[[^\]]*\];/;

function argList(flag: string): string[] {
  const i = process.argv.indexOf(flag);
  if (i === -1) return [];
  return (process.argv[i + 1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function main() {
  const add = argList("--add");
  const drop = argList("--drop");
  const leagues = [...TRAINING_LEAGUES];

  for (const league of add) {
    if (leagues.includes(league)) fail(`${league} is already a training league.`);
    if (league === CURRENT_LEAGUE) fail(`${league} is still running (CURRENT_LEAGUE); train on it once it ends.`);
    if (!leagueReleaseDate(league)) fail(`${league} has no release date in lib/league-recency.ts. Add it there first.`);
    leagues.push(league);
  }
  for (const league of drop) {
    const i = leagues.indexOf(league);
    if (i === -1) fail(`${league} is not a training league (have: ${leagues.join(", ")}).`);
    leagues.splice(i, 1);
  }
  // Every full-model row needs MIN_LEAGUES_WITH_DATA other leagues to build its features from.
  if (leagues.length < MIN_LEAGUES_WITH_DATA + 1) {
    fail(`Need at least ${MIN_LEAGUES_WITH_DATA + 1} training leagues, would have ${leagues.length}.`);
  }

  // Newest first, matching how the list has always been written.
  leagues.sort((a, b) => (leagueReleaseDate(b) ?? "").localeCompare(leagueReleaseDate(a) ?? ""));
  const holdouts = [...new Set([leagues[0], ...(leagues.includes(SIMULATED_LEAGUE) ? [SIMULATED_LEAGUE] : [])])];

  const changed = add.length > 0 || drop.length > 0;
  if (changed) {
    const source = fs.readFileSync(FILE, "utf8");
    if (!LIST_RE.test(source)) fail(`Couldn't find the TRAINING_LEAGUES array in ${FILE}.`);
    const list = `export const TRAINING_LEAGUES: readonly string[] = [${leagues.map((l) => JSON.stringify(l)).join(", ")}];`;
    fs.writeFileSync(FILE, source.replace(LIST_RE, list));
  }

  console.log(`Training leagues: ${leagues.join(", ")}${changed ? " (updated)" : " (unchanged)"}`);
  console.log(`Holdouts: ${holdouts.join(", ")}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `leagues=${leagues.join(",")}\nholdouts=${holdouts.join(",")}\nchanged=${changed}\n`
    );
  }
}

main();
