/**
 * Downloads the training leagues' price history into POE_DATA_DIR in the layout scripts/ingest-history.ts
 * reads (<League>/<League>.currency.csv + <League>.items.csv). Used by the "Retrain model" workflow; also
 * works locally.
 *
 *   npx tsx scripts/download-league-history.ts [League ...]      (default: lib/training-leagues.ts)
 *
 * Per league, first match wins:
 *   1. already on disk (FORCE=1 re-downloads);
 *   2. poe.ninja's export, published after a league ends: GET /poe1/api/data/dumps lists them, and
 *      /poe1/api/data/dumps/dump?name=<League> is a zip that also holds hardcore/standard files we skip;
 *   3. this app's own daily snapshots on the data branch (history/<League>/*.YYYY-MM.csv), for a league
 *      that ended but isn't exported yet (never CURRENT_LEAGUE, which may still be running). Less
 *      complete: only the items poe.ninja's live API listed, and only since collection began.
 *
 * Writes sources.json (league -> where its data came from) to RETRAIN_OUT when set, for the report.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "dotenv";
import { CURRENT_LEAGUE } from "../lib/league-recency";
import { TRAINING_LEAGUES } from "../lib/training-leagues";

config({ path: ".env.local" });

const DATA_DIR = process.env.POE_DATA_DIR
  ? path.resolve(process.env.POE_DATA_DIR)
  : path.resolve(process.cwd(), "..", "poe-pricing", "data");
const REPO = process.env.PREDICTIONS_REPO ?? "WesleySZhang/poe-flipper";
const HEADERS = { "User-Agent": "poe-flipper retrain (github.com/WesleySZhang/poe-flipper)" };

export interface LeagueSource {
  league: string;
  source: "local" | "poe.ninja export" | "data branch";
  detail: string;
}

interface NinjaDump {
  leagueName: string;
  minDate: string;
  maxDate: string;
}

async function fetchOk(url: string, headers: Record<string, string> = HEADERS): Promise<Response> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/** unzip where it exists (Linux, Git Bash), else Windows' bsdtar, which also reads zips. */
function extract(zipPath: string, files: string[], destDir: string) {
  try {
    execFileSync("unzip", ["-o", "-j", zipPath, ...files, "-d", destDir], { stdio: "ignore" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    execFileSync("tar", ["-xf", zipPath, "-C", destDir, ...files], { stdio: "ignore" });
  }
}

async function fromNinja(league: string, dump: NinjaDump, destDir: string): Promise<string> {
  const url = `https://poe.ninja/poe1/api/data/dumps/dump?name=${encodeURIComponent(league)}`;
  const zipPath = path.join(os.tmpdir(), `${league}.zip`);
  fs.writeFileSync(zipPath, Buffer.from(await (await fetchOk(url)).arrayBuffer()));
  try {
    extract(zipPath, [`${league}.currency.csv`, `${league}.items.csv`], destDir);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
  return `${dump.minDate.slice(0, 10)} to ${dump.maxDate.slice(0, 10)}`;
}

async function fromDataBranch(league: string, destDir: string): Promise<string | undefined> {
  const api = `https://api.github.com/repos/${REPO}/contents/history/${encodeURIComponent(league)}?ref=data`;
  const headers: Record<string, string> = { ...HEADERS, Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(api, { headers });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${api}: HTTP ${res.status}`);
  const entries = (await res.json()) as Array<{ name: string; download_url: string }>;
  const chunks = entries.filter((e) => /\.(currency|items)\.\d{4}-\d{2}\.csv$/.test(e.name));
  if (chunks.length === 0) return undefined;
  for (const chunk of chunks) {
    fs.writeFileSync(path.join(destDir, chunk.name), await (await fetchOk(chunk.download_url)).text());
  }
  return `${chunks.length} monthly files: ${chunks.map((c) => c.name.replace(`${league}.`, "")).join(", ")}`;
}

async function main() {
  const leagues = process.argv.length > 2 ? process.argv.slice(2) : [...TRAINING_LEAGUES];
  const dumps = (await (await fetchOk("https://poe.ninja/poe1/api/data/dumps")).json()) as NinjaDump[];
  const sources: LeagueSource[] = [];

  for (const league of leagues) {
    const destDir = path.join(DATA_DIR, league);
    const onDisk = fs.existsSync(destDir) && fs.readdirSync(destDir).some((f) => /\.(currency|items).*\.csv$/.test(f));
    if (onDisk && !process.env.FORCE) {
      sources.push({ league, source: "local", detail: destDir });
      console.log(`${league}: already in ${destDir}`);
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    const dump = dumps.find((d) => d.leagueName === league);
    if (dump) {
      const detail = await fromNinja(league, dump, destDir);
      sources.push({ league, source: "poe.ninja export", detail });
      console.log(`${league}: poe.ninja export (${detail})`);
      continue;
    }
    // The data branch keeps growing while a league runs; without an export it hasn't ended.
    if (league === CURRENT_LEAGUE) throw new Error(`${league} is still running (no poe.ninja export yet).`);
    const detail = await fromDataBranch(league, destDir);
    if (!detail) throw new Error(`${league}: no poe.ninja export and no history on the data branch.`);
    sources.push({ league, source: "data branch", detail });
    console.log(`${league}: no poe.ninja export yet, used the data branch (${detail})`);
  }

  if (process.env.RETRAIN_OUT) {
    fs.mkdirSync(process.env.RETRAIN_OUT, { recursive: true });
    fs.writeFileSync(path.join(process.env.RETRAIN_OUT, "sources.json"), JSON.stringify(sources, null, 1));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
