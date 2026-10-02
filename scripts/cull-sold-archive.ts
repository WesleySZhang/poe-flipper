/**
 * Deletes records from the sold tracker's archive (ended/ under --dir) when it gets too big - the
 * tracker's run log warns past ARCHIVE_WARN_BYTES (lib/sold-tracker.ts). A dry run by default: it
 * prints what it would delete, and deletes only with --confirm. Culling can't be undone, so back up
 * first; the "Cull sold tracker archive" workflow saves ended/ as a run artifact before it deletes.
 *
 *   npx tsx scripts/cull-sold-archive.ts --dir <tracker dir> [--league <League>]
 *       [--search "<label>"]   records found only by this search (e.g. a removed one)
 *       [--before YYYY-MM-DD]  whole days before this date
 *       [--all-league]         everything for --league (a past league)
 *       [--confirm]
 *
 * Filters combine: --search and --before together delete that search's records before that date.
 * The tracker must not be running on the same --dir (the workflow shares its concurrency group).
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { CURRENT_LEAGUE } from "../lib/league-recency";
import type { TrackedListing } from "../lib/sold-tracker";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const dir = arg("dir") ?? ".sold-tracker";
const league = arg("league") ?? CURRENT_LEAGUE;
const search = arg("search");
const before = arg("before");
const allLeague = flag("all-league");
const confirm = flag("confirm");
const archiveDir = path.join(dir, "ended", league);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!search && !before && !allLeague) fail("Nothing to cull: give --search, --before and/or --all-league.");
if (before && !/^\d{4}-\d{2}-\d{2}$/.test(before)) fail(`--before must be YYYY-MM-DD, not "${before}".`);
if (allLeague && league === CURRENT_LEAGUE) fail(`--all-league is for a past league; ${league} is the current one.`);
if (!existsSync(archiveDir)) fail(`No archive at ${archiveDir}.`);

const verb = confirm ? "Deleted" : "Would delete";
let freed = 0;
let records = 0;

if (allLeague) {
  for (const name of readdirSync(archiveDir)) freed += statSync(path.join(archiveDir, name)).size;
  console.log(`${verb} all of ${league}'s archive: ${archiveDir} (${mb(freed)})`);
  if (confirm) rmSync(archiveDir, { recursive: true });
  for (const f of [path.join(dir, "state", `${league}.json`), path.join(dir, "sold-listings", `${league}.json`)]) {
    if (!existsSync(f)) continue;
    console.log(`${verb} ${f}`);
    if (confirm) unlinkSync(f);
  }
  process.exit(0);
}

for (const name of readdirSync(archiveDir).sort()) {
  const day = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/)?.[1];
  if (!day || (before && day >= before)) continue;
  const file = path.join(archiveDir, name);
  const gz = name.endsWith(".gz");
  const size = statSync(file).size;
  const lines = (gz ? gunzipSync(readFileSync(file)).toString("utf8") : readFileSync(file, "utf8")).split("\n").filter((l) => l.trim());
  // Only this search found it: other searches' records stay.
  const keep = search
    ? lines.filter((l) => {
        const t = JSON.parse(l) as TrackedListing;
        return !(t.searches.length > 0 && t.searches.every((s) => s === search));
      })
    : [];
  const removed = lines.length - keep.length;
  if (removed === 0) continue;
  records += removed;
  if (keep.length === 0) {
    freed += size;
    console.log(`${verb} ${name}: all ${removed} records (${mb(size)})`);
    if (confirm) unlinkSync(file);
  } else {
    const text = keep.join("\n") + "\n";
    const out = gz ? gzipSync(text) : Buffer.from(text);
    freed += size - out.length;
    console.log(`${verb} ${removed} of ${lines.length} records from ${name}`);
    if (confirm) writeFileSync(file, out);
  }
}
console.log(`${verb} ${records} records, ${mb(freed)}${confirm ? "" : " - dry run; add --confirm to delete"}.`);
