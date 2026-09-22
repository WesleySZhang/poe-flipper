/**
 * Checks poe.ninja's live leagues list against lib/league-recency.ts's hardcoded CURRENT_LEAGUE,
 * same as scripts/check-current-league.ts - but where that script only reports a mismatch, this
 * one actually rewrites lib/league-recency.ts to fix it: adds the new league's release date (set
 * to TODAY, the day this script first detects it - not the league's true launch instant) and
 * points CURRENT_LEAGUE at it. Everything downstream (day_offset math, the daily precompute job,
 * live pricing lookups) already keys off those two exports alone (see that file's own comments),
 * so this one edit is the entire "swap."
 *
 * Being off by however many hours elapse between the real launch and this script's next scheduled
 * run is no worse than the manual alternative it replaces (a human noticing and editing by hand,
 * usually later still) - this app's day_offset math is day-granularity everywhere already.
 *
 * Run by .github/workflows/check-current-league-swap.yml, which opens a pull request with the
 * resulting diff rather than pushing straight to master - see that workflow's own comment for why
 * (this feeds live economy data to every visitor; a bad detection - a poe.ninja hiccup, an
 * unexpected reordering - should get a human's eyes before it deploys, not skip straight to it).
 * Sets GITHUB_OUTPUT's changed/new_league/old_league for that workflow to key off.
 *
 * On a match, or on any failure to even check, makes no changes and reports nothing changed - same
 * "degrade gracefully, never crash the job" pattern as check-current-league.ts and the rest of this
 * app's poe.ninja-dependent code. Also safe to run locally by hand (npm run league:sync) to preview
 * what it would do - it just edits the file on disk, same as any other local edit.
 */
import fs from "node:fs";
import path from "node:path";
import { CURRENT_LEAGUE } from "../lib/league-recency";

const LEAGUES_URL = "https://poe.ninja/poe1/api/economy/leagues";
const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
const LEAGUE_RECENCY_PATH = path.join(__dirname, "..", "lib", "league-recency.ts");

interface PoeNinjaLeague {
  id: string;
  name: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Writes a GITHUB_OUTPUT entry when running in Actions; a harmless no-op locally (GITHUB_OUTPUT
 *  is unset outside CI). */
function setOutput(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${value}\n`);
}

async function main() {
  const res = await fetch(LEAGUES_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    console.log(`poe.ninja leagues request failed (${res.status}) - skipping, no change made.`);
    setOutput("changed", "false");
    return;
  }

  const leagues = (await res.json()) as PoeNinjaLeague[];
  const live = leagues[0]?.id;
  if (!live) {
    console.log("poe.ninja returned no leagues at all - skipping, no change made.");
    setOutput("changed", "false");
    return;
  }
  // Same guard as check-current-league.ts's own - never trust an apparent "swap" to a permanent
  // league, in case poe.ninja ever reorders this endpoint's results.
  if (live === "Standard" || live === "Hardcore") {
    console.log(`First league entry was "${live}", which looks permanent, not temporary - skipping, no change made.`);
    setOutput("changed", "false");
    return;
  }

  if (live === CURRENT_LEAGUE) {
    console.log(`Still ${CURRENT_LEAGUE} - no change needed.`);
    setOutput("changed", "false");
    return;
  }

  const today = isoDate(new Date());
  console.log(`Detected a league swap: ${CURRENT_LEAGUE} -> ${live} (as of ${today}).`);

  let source = fs.readFileSync(LEAGUE_RECENCY_PATH, "utf8");

  const currentLeagueLine = `export const CURRENT_LEAGUE = "${CURRENT_LEAGUE}";`;
  if (!source.includes(currentLeagueLine)) {
    throw new Error(
      `Expected to find ${JSON.stringify(currentLeagueLine)} in lib/league-recency.ts - the ` +
        "file's shape has likely changed since this script was written; update it by hand this time."
    );
  }
  source = source.replace(currentLeagueLine, `export const CURRENT_LEAGUE = "${live}";`);

  // New league's release date goes first in the table, per its own "most recent first" doc comment.
  // Bare identifier when the name allows it (matching every existing unquoted entry), quoted
  // otherwise (matching existing entries like "Phrecia 2.0" that contain a space). Matches \r?\n
  // rather than a literal file read/write of "\n" - a Windows checkout (core.autocrlf=true) has
  // this file on disk as CRLF even though it's stored as LF in the repo, and a plain string match
  // would otherwise silently fail to find the insertion point on a machine checked out that way.
  const tableHeaderRe = /const LEAGUE_RELEASE_DATES: Record<string, string> = \{\r?\n/;
  const headerMatch = tableHeaderRe.exec(source);
  if (!headerMatch) {
    throw new Error(
      "Expected to find LEAGUE_RELEASE_DATES's opening brace in lib/league-recency.ts - update it by hand this time."
    );
  }
  const keyLiteral = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(live) ? live : JSON.stringify(live);
  const newline = source.includes("\r\n") ? "\r\n" : "\n"; // match the file's own existing convention
  const insertAt = headerMatch.index + headerMatch[0].length;
  source = source.slice(0, insertAt) + `  ${keyLiteral}: "${today}",${newline}` + source.slice(insertAt);

  fs.writeFileSync(LEAGUE_RECENCY_PATH, source);

  setOutput("changed", "true");
  setOutput("new_league", live);
  setOutput("old_league", CURRENT_LEAGUE);
}

main().catch((err) => {
  console.error("League sync check errored:", err);
  process.exitCode = 1;
});
