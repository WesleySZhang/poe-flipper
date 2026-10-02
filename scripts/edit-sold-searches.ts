/**
 * Adds or removes a search in sold-tracker/searches.md - run by the "Add or remove a sold tracker
 * search" workflow (.github/workflows/edit-sold-search.yml), which then opens a PR so the usual
 * "Check sold tracker searches" check runs before it's merged. Also works locally:
 *
 *   npx tsx scripts/edit-sold-searches.ts add "<trade site link>" ["<label>"]
 *   npx tsx scripts/edit-sold-searches.ts remove "<label or link>"
 *
 * Fails (exit 1, nothing written) when the link can't be read, the label or link is already
 * there, or nothing matches a removal. Writes `label` to $GITHUB_OUTPUT when set.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { SEARCHES_DOC, addSearchToDoc, removeSearchFromDoc } from "../lib/sold-tracker-searches";

const [action, target, label] = process.argv.slice(2);

try {
  if (!target?.trim()) throw new Error("Give a trade site link (add) or a label/link (remove)");
  const text = readFileSync(SEARCHES_DOC, "utf8");
  let result: { text: string; label: string };
  if (action === "add") result = addSearchToDoc(text, target, label);
  else if (action === "remove") result = removeSearchFromDoc(text, target);
  else throw new Error(`Unknown action "${action}" - use add or remove`);
  writeFileSync(SEARCHES_DOC, result.text);
  console.log(`${action === "add" ? "Added" : "Removed"} "${result.label}"`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `label=${result.label}\n`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
