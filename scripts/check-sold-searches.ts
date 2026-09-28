/**
 * Checks sold-tracker/searches.md against the tracker's limits (lib/sold-tracker.ts) before it's
 * merged - the "Check sold tracker searches" PR check, also `npm run sold:check` locally.
 *
 * Every search runs once against the trade site with the tracker's rules applied (instant buyout,
 * listed in the last week), and the check fails when:
 *  - a link can't be read, or two searches share a label;
 *  - there are more than MAX_SEARCHES searches;
 *  - one search matches more than MAX_LISTINGS_PER_SEARCH listings right now;
 *  - all searches together match more than MAX_TRACKED_LISTINGS;
 *  - a search can't be measured (the trade site refused or failed) - it fails closed.
 * A search's match count is roughly how many listings it will have the tracker following, since
 * listings drop out after a week. It's a count for today's market: a quiet league understates a
 * busy one, which is what the tracker's own runtime limits are for.
 *
 *   npx tsx scripts/check-sold-searches.ts [--searches sold-tracker/searches.md]
 *
 * Writes a Markdown report to $GITHUB_STEP_SUMMARY when set (the PR check's summary page).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { CURRENT_LEAGUE } from "../lib/league-recency";
import { TradeApiClient } from "../lib/trade-api";
import { SEARCHES_DOC, parseSearchesDoc } from "../lib/sold-tracker-searches";
import { MAX_LISTINGS_PER_SEARCH, MAX_SEARCHES, MAX_TRACKED_LISTINGS, formatSearchTotal } from "../lib/sold-tracker";
// Flag (without failing) anything past this share of a limit.
const WARN_FRACTION = 0.8;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Row {
  label: string;
  total?: number;
  result: "ok" | "warn" | "fail";
  note: string;
}

function formatTotal(total: number | undefined): string {
  return total === undefined ? "—" : formatSearchTotal(total);
}

async function main() {
  const path = arg("searches", SEARCHES_DOC);
  const searches = parseSearchesDoc(readFileSync(path, "utf8"));
  const client = new TradeApiClient();
  const rows: Row[] = [];
  const problems: string[] = [];

  if (searches.length > MAX_SEARCHES) problems.push(`${searches.length} searches - the limit is ${MAX_SEARCHES}.`);

  for (const s of searches) {
    if (s.error || !s.query) {
      rows.push({ label: s.label, result: "fail", note: s.error ?? "Can't read the link" });
      continue;
    }
    try {
      const { total } = await client.search(CURRENT_LEAGUE, s.query, { indexed: "desc" });
      if (total > MAX_LISTINGS_PER_SEARCH) {
        rows.push({ label: s.label, total, result: "fail", note: `Over the ${MAX_LISTINGS_PER_SEARCH.toLocaleString("en-US")}-listing limit per search - narrow it` });
      } else if (total > MAX_LISTINGS_PER_SEARCH * WARN_FRACTION) {
        rows.push({ label: s.label, total, result: "warn", note: `Near the ${MAX_LISTINGS_PER_SEARCH.toLocaleString("en-US")}-listing limit; a busier league may pause it` });
      } else {
        rows.push({ label: s.label, total, result: "ok", note: "" });
      }
    } catch (e) {
      rows.push({ label: s.label, result: "fail", note: `Couldn't measure: ${(e as Error).message.slice(0, 160)}` });
    }
  }

  const sum = rows.reduce((n, r) => n + (r.total ?? 0), 0);
  if (sum > MAX_TRACKED_LISTINGS) {
    problems.push(`All searches together match ${sum.toLocaleString("en-US")} listings - the limit is ${MAX_TRACKED_LISTINGS.toLocaleString("en-US")}.`);
  }
  const failed = problems.length > 0 || rows.some((r) => r.result === "fail");
  const nearTotal = !failed && sum > MAX_TRACKED_LISTINGS * WARN_FRACTION;

  const icon = { ok: "✅", warn: "⚠️", fail: "❌" } as const;
  const lines = [
    `## Sold tracker searches: ${failed ? "❌ over the limits" : "✅ within the limits"}`,
    "",
    `League ${CURRENT_LEAGUE}. Each search counted with the tracker's rules (instant buyout, listed in the last week).`,
    "",
    "| Search | Listings now | |",
    "| --- | ---: | --- |",
    ...rows.map((r) => `| ${r.label.replace(/\|/g, "\\|")} | ${formatTotal(r.total)} | ${icon[r.result]} ${r.note} |`),
    `| **Total** | **${sum.toLocaleString("en-US")}** / ${MAX_TRACKED_LISTINGS.toLocaleString("en-US")} | ${
      sum > MAX_TRACKED_LISTINGS ? icon.fail : nearTotal ? `${icon.warn} Near the limit` : icon.ok
    } |`,
    "",
    ...problems.map((p) => `- ❌ ${p}`),
    `Limits: ${MAX_LISTINGS_PER_SEARCH.toLocaleString("en-US")} listings per search, ${MAX_TRACKED_LISTINGS.toLocaleString("en-US")} in total, ${MAX_SEARCHES} searches (lib/sold-tracker.ts).`,
  ];
  const report = lines.join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
