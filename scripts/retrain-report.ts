/**
 * Writes the "Retrain model" workflow's pull request body: where each league's data came from and how much
 * of the league it covers, the new model's validation scores next to the previous model's (both embedded in
 * predictor.json as "validation"), the parity check and the Mirage backtest.
 *
 *   npx tsx scripts/retrain-report.ts --old <previous predictor.json> [--added A,B] [--dropped C]
 *
 * Reads sources.json, fit.log, parity-*.log and backtest.log from RETRAIN_OUT (default: the OS temp dir's
 * "retrain" folder) and writes report.md there. Writes `regression` to GITHUB_OUTPUT when set.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../lib/db";
import type { HoldoutValidation, PredictorModel } from "../lib/prediction-model";
import { TRAINING_LEAGUES } from "../lib/training-leagues";
import type { LeagueSource } from "./download-league-history";

const OUT = process.env.RETRAIN_OUT ?? path.join(os.tmpdir(), "retrain");
const NEW_MODEL = path.join(__dirname, "..", "lib", "models", "predictor.json");
// A drop in XGBoost's per-scenario Spearman on the same holdout bigger than this is called out as a regression.
const REGRESSION_RHO = 0.01;
// A league whose prices start later than this is missing its early days, where the model is most useful.
const MAX_FIRST_DAY = 3;
const MAX_BODY = 60000; // GitHub caps a PR body at 65536 characters

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function list(flag: string): string[] {
  return (arg(flag) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readText(name: string): string | undefined {
  const file = path.join(OUT, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : undefined;
}

const signed = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(3);

interface Coverage {
  firstDay: number;
  lastDay: number;
  days: number;
  items: number;
}

async function coverage(): Promise<Map<string, Coverage>> {
  const db = await getDb();
  const cur = await db.runAndReadAll(
    "SELECT league, MIN(day_offset) AS first, MAX(day_offset) AS last, COUNT(DISTINCT day_offset) AS days FROM currency_history_dayed GROUP BY league"
  );
  const items = await db.runAndReadAll(
    "SELECT league, COUNT(DISTINCT name || '::' || COALESCE(variant, '')) AS n FROM item_history_dayed GROUP BY league"
  );
  const itemCount = new Map(items.getRowObjects().map((r) => [String(r.league), Number(r.n)]));
  return new Map(
    cur.getRowObjects().map((r) => [
      String(r.league),
      {
        firstDay: Number(r.first),
        lastDay: Number(r.last),
        days: Number(r.days),
        items: itemCount.get(String(r.league)) ?? 0,
      },
    ])
  );
}

function validationTable(
  oldVal: Record<string, HoldoutValidation> | undefined,
  newVal: Record<string, HoldoutValidation>
): { lines: string[]; regressions: string[] } {
  const lines = [
    "| Holdout | Scores | Leagues trained on | Spearman | Top-10% hit | Top-10% return |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const regressions: string[] = [];
  for (const [holdout, n] of Object.entries(newVal)) {
    const o = oldVal?.[holdout];
    for (const denom of ["chaos", "divine"] as const) {
      const nx = n[denom]?.xgb;
      if (!nx) continue;
      const ox = o?.[denom]?.xgb;
      const cell = (key: "rho" | "hit" | "top10", pct = false) => {
        const fmt = (v: number) => (pct ? `${(v * 100).toFixed(1)}%` : v.toFixed(3));
        if (!ox) return fmt(nx[key]);
        const delta = nx[key] - ox[key];
        const d = pct ? `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp` : signed(delta);
        return `${fmt(ox[key])} → **${fmt(nx[key])}** (${d})`;
      };
      const trained = o ? `${o.trainLeagues} → ${n.trainLeagues}` : `${n.trainLeagues}`;
      lines.push(`| ${holdout} | ${denom} | ${trained} | ${cell("rho")} | ${cell("hit", true)} | ${cell("top10")} |`);
      if (ox && nx.rho < ox.rho - REGRESSION_RHO) regressions.push(`${holdout} ${denom} Spearman ${signed(nx.rho - ox.rho)}`);
    }
  }
  return { lines, regressions };
}

async function main() {
  const oldPath = arg("--old");
  const oldModel: PredictorModel | undefined =
    oldPath && fs.existsSync(oldPath) ? JSON.parse(fs.readFileSync(oldPath, "utf8")) : undefined;
  const newModel: PredictorModel = JSON.parse(fs.readFileSync(NEW_MODEL, "utf8"));
  const added = list("--added");
  const dropped = list("--dropped");
  const sources: LeagueSource[] = JSON.parse(readText("sources.json") ?? "[]");
  const cov = await coverage();

  const md: string[] = [];
  const change = [
    ...added.map((l) => `adds **${l}**`),
    ...dropped.map((l) => `drops **${l}**`),
  ];
  md.push(
    change.length > 0
      ? `Retrained the prediction model: ${change.join(", ")}.`
      : "Retrained the prediction model on the same leagues (no training set change)."
  );
  md.push("", `Training leagues: ${TRAINING_LEAGUES.join(", ")}.`, "");

  md.push("## Data", "", "| League | Source | Detail | Days in DB | Items |", "| --- | --- | --- | --- | --- |");
  const warnings: string[] = [];
  for (const league of TRAINING_LEAGUES) {
    const s = sources.find((x) => x.league === league);
    const c = cov.get(league);
    const days = c ? `${c.days} (day ${c.firstDay}–${c.lastDay})` : "none";
    md.push(`| ${league} | ${s?.source ?? "?"} | ${s?.detail ?? ""} | ${days} | ${c?.items.toLocaleString() ?? 0} |`);
    if (s?.source === "precompute-data branch") {
      warnings.push(
        `**${league}** came from the app's own daily snapshots, not poe.ninja's export (not published yet). ` +
          "Consider waiting for the export and rerunning."
      );
    }
    if (!c) warnings.push(`**${league}** has no prices in the DB.`);
    else if (c.firstDay > MAX_FIRST_DAY) warnings.push(`**${league}**'s prices start at league day ${c.firstDay}.`);
  }
  md.push("");
  if (warnings.length > 0) md.push(...warnings.map((w) => `> ⚠️ ${w}`), "");

  md.push("## Validation", "");
  md.push(
    "XGBoost, leave-one-league-out: trained without the holdout league, scored on it. " +
      "Previous → **new** where the previous model recorded the same holdout. " +
      "The test rows differ slightly between runs (features use the other training leagues).",
    ""
  );
  let regressions: string[] = [];
  if (newModel.validation) {
    const t = validationTable(oldModel?.validation, newModel.validation);
    md.push(...t.lines, "");
    regressions = t.regressions;
    if (!oldModel?.validation) md.push("The previous model recorded no validation scores, so there's nothing to compare.", "");
  } else {
    md.push("The new model has no validation scores (fit_production.py validate didn't run).", "");
  }
  md.push(
    regressions.length > 0
      ? `> ⚠️ **Worse than the previous model:** ${regressions.join("; ")}.`
      : "No holdout got worse by more than 0.01 Spearman.",
    ""
  );

  const parity = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => /^parity-.*\.log$/.test(f)) : [];
  md.push("## Checks", "");
  for (const f of parity) {
    const text = readText(f) ?? "";
    const ok = text.includes("PARITY OK");
    md.push(`- TypeScript vs Python parity (${f.slice(7, -4)} holdout): ${ok ? "passed" : "**failed**"}`);
  }
  const backtest = readText("backtest.log");
  if (backtest) {
    md.push("", "<details><summary>Mirage replay through the app (scripts/backtest-predictor.ts)</summary>", "");
    md.push("```", backtest.replace(/^.*\r/gm, ""), "```", "</details>");
  } else {
    md.push("- Mirage replay: skipped (Mirage isn't a holdout).");
  }
  const fit = readText("fit.log");
  if (fit) md.push("", "<details><summary>Full validation report (ml/fit_production.py)</summary>", "", "```", fit, "```", "</details>");

  md.push(
    "",
    "## After merging",
    "",
    "1. The **Precompute predictions** workflow reruns by itself (the model file changed).",
    "2. Run **Deploy to production**: the app ships `db/history.duckdb` for charts and live fallbacks.",
    "3. If the results section of `ml/README.md` should reflect this run, update it."
  );

  let body = md.join("\n");
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY) + "\n\n(truncated; the full logs are in the workflow run.)";
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "report.md"), body);
  console.log(body);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `regression=${regressions.length > 0}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
