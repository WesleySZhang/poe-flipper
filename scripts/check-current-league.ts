/**
 * Checks whether lib/league-recency.ts's hardcoded CURRENT_LEAGUE still matches the league
 * actually active right now, against poe.ninja's own economy-leagues endpoint
 * (https://poe.ninja/poe1/api/economy/leagues - undocumented on poe.ninja's public site, but a
 * real, working, unauthenticated GET with no query params, found via their own API reference at
 * poe.ninja/docs/api). Returns a plain array of `{ id, name }`, always with the current temporary
 * challenge league first, followed by its Hardcore variant, then the permanent Standard/Hardcore
 * leagues - e.g. `[{"id":"Allflame",...}, {"id":"Hardcore Allflame",...}, {"id":"Standard",...},
 * {"id":"Hardcore",...}]`. Run by hand whenever a new challenge league might have launched -
 * CURRENT_LEAGUE has no automatic way to update itself, by design (see that file's own comment).
 *
 * Usage: npm run check-league
 */
import { CURRENT_LEAGUE } from "../lib/league-recency";

const LEAGUES_URL = "https://poe.ninja/poe1/api/economy/leagues";
const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";

interface PoeNinjaLeague {
  id: string;
  name: string;
}

// process.exitCode, not process.exit() - forcing an immediate exit while fetch's underlying
// keep-alive handle is still around trips a libuv teardown assertion on Windows/Node 24 that
// clobbers the real exit code. Setting exitCode and letting main() return lets Node exit on its
// own once the event loop drains, which reports the intended code correctly.
async function main() {
  const res = await fetch(LEAGUES_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    console.error(`poe.ninja leagues request failed (${res.status}) - can't check right now.`);
    process.exitCode = 1;
    return;
  }

  const leagues = (await res.json()) as PoeNinjaLeague[];
  const live = leagues[0]?.id;

  if (!live) {
    console.error("poe.ninja returned no leagues at all - can't check right now.");
    process.exitCode = 1;
    return;
  }
  // Sanity check on the assumption this script is built on (first entry = current temp league,
  // not a permanent one) - if poe.ninja ever reorders this, fail loud rather than silently trust
  // a wrong "live" value.
  if (live === "Standard" || live === "Hardcore") {
    console.error(
      `poe.ninja's first league entry was "${live}", which looks like a permanent league, not a ` +
        "temporary challenge league - poe.ninja may have changed how this endpoint orders results. " +
        "Treating this as unable to check rather than trusting a possibly-wrong value."
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Hardcoded (lib/league-recency.ts): ${CURRENT_LEAGUE}`);
  console.log(`Live on poe.ninja right now:        ${live}`);

  if (live === CURRENT_LEAGUE) {
    console.log("\nUp to date - no action needed.");
    return;
  }

  console.log(
    `\nOut of date - poe.ninja is serving "${live}", not "${CURRENT_LEAGUE}". A new league has ` +
      "likely launched. Update lib/league-recency.ts's LEAGUE_RELEASE_DATES (add the new league's " +
      "release date) and CURRENT_LEAGUE before relying on flip suggestions or the Currency " +
      "Exchange Flip page - both key off CURRENT_LEAGUE directly."
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("League check errored:", err);
  process.exitCode = 1;
});
