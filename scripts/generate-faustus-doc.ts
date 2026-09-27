/**
 * Regenerates docs/faustus-mapping.md from lib/faustus.ts's FAUSTUS_NAME_TO_ID - a human-readable
 * reference for the poe.ninja display name <-> GGG Currency Exchange (Faustus) metadata-id mapping.
 * Not part of the running app. Re-run after scripts/generate-faustus-mapping.ts updates the map.
 */
import fs from "node:fs";
import path from "node:path";
import { readFaustusMap } from "./generated-data";

const OUT_PATH = path.join(__dirname, "..", "docs", "faustus-mapping.md");

function categoryFor(id: string): string {
  if (id.startsWith("Metadata/Items/DivinationCards/")) return "Divination Cards";
  if (id.startsWith("Metadata/Items/Scarabs/")) return "Scarabs";
  if (id.startsWith("Metadata/Items/MapFragments/")) return "Fragments";
  if (id.startsWith("Metadata/Items/AtlasExiles/")) return "Conqueror Exalted Orbs";
  if (id.startsWith("Metadata/Items/Deepwater/")) return "Deepwater (Allflame)";
  if (id.startsWith("Metadata/Items/Heist/")) return "Heist";
  if (id.startsWith("Metadata/Items/Currency/")) return "Currency";
  return "Other";
}

/** Rewrites the doc from lib/faustus.ts's current map. Returns whether the file changed. Also used by
 *  scripts/check-new-items.ts. */
export function writeFaustusDoc(): boolean {
  const map: Record<string, string> = Object.fromEntries(readFaustusMap());

  const byCategory = new Map<string, Array<[string, string]>>();
  for (const [name, id] of Object.entries(map)) {
    const category = categoryFor(id);
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push([name, id]);
  }

  const CATEGORY_ORDER = [
    "Currency",
    "Fragments",
    "Scarabs",
    "Essences",
    "Divination Cards",
    "Conqueror Exalted Orbs",
    "Deepwater (Allflame)",
    "Heist",
    "Other",
  ];
  // Essences aren't their own path prefix (they live under Currency/) - split them out specially
  // since there are enough of them to be worth their own section.
  const currencyEntries = byCategory.get("Currency") ?? [];
  const essenceEntries = currencyEntries.filter(([, id]) => id.includes("/CurrencyEssence"));
  const restCurrencyEntries = currencyEntries.filter(([, id]) => !id.includes("/CurrencyEssence"));
  byCategory.set("Currency", restCurrencyEntries);
  byCategory.set("Essences", essenceEntries);

  const total = Object.keys(map).length;
  const lines: string[] = [];
  lines.push("# Faustus (GGG Currency Exchange) name mapping");
  lines.push("");
  lines.push(
    `Generated from \`lib/faustus.ts\`'s \`FAUSTUS_NAME_TO_ID\` - **do not hand-edit this file**; re-run \`npx tsx scripts/generate-faustus-doc.ts\` after \`scripts/generate-faustus-mapping.ts\` updates the map (e.g. after a new league).`
  );
  lines.push("");
  lines.push(
    `${total} entries. Left column is the display name this app (and poe.ninja) uses; right column is ` +
      `GGG's internal game-file path for that same item, as used by the Currency Exchange API ` +
      `(\`https://web.poecdn.com/api/currency-exchange\`). See \`lib/faustus.ts\`'s header comment for how ` +
      `this mapping was built (via RePoE, since GGG's own endpoint never exposes a display name itself) ` +
      `and why it's scoped to only currently-tradeable items rather than every item GGG's game files know about.`
  );
  lines.push("");

  for (const category of CATEGORY_ORDER) {
    const entries = byCategory.get(category);
    if (!entries || entries.length === 0) continue;
    entries.sort(([a], [b]) => a.localeCompare(b));
    lines.push(`## ${category} (${entries.length})`);
    lines.push("");
    lines.push("| Name | GGG metadata id |");
    lines.push("| --- | --- |");
    for (const [name, id] of entries) {
      lines.push(`| ${name.replace(/\|/g, "\\|")} | \`${id}\` |`);
    }
    lines.push("");
  }

  const out = lines.join("\n");
  const previous = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, "utf8").replace(/\r\n/g, "\n") : undefined;
  if (previous === out) return false;
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, out);
  return true;
}

if (require.main === module) {
  console.log(writeFaustusDoc() ? `Wrote ${OUT_PATH}.` : `${OUT_PATH} already up to date.`);
}
