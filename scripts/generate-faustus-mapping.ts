/**
 * Regenerates lib/faustus.ts's FAUSTUS_NAME_TO_ID map. Run this again whenever a new league adds
 * Currency Exchange-tradeable items this app should pick up (a scarab rework, a new essence tier,
 * etc.) - not part of the running app itself.
 *
 * Earlier attempts (see git history / this file's own history) tried deriving a display name from
 * each metadata id's own structure and validating it against known names - workable for Divination
 * Cards and Essences (their ids are self-describing enough), but Scarabs turned out to have a real
 * collision problem: several genuinely different, differently-priced tiers within one mechanic
 * (e.g. "Anarchy Scarab" vs "Anarchy Scarab of Gigantification") all derived to the same generic
 * name and validated as false positives.
 *
 * Uses RePoE (https://github.com/repoe-fork/repoe, an actively-maintained community mirror of PoE's
 * own game files - unofficial, but a direct machine-file dump rather than a guess) as ground truth
 * instead: every GGG metadata id it's ever seen maps directly to that item's real display name, no
 * derivation needed. Scoped to only the ids GGG's live Currency Exchange actually has open markets
 * for right now, so the generated map only ever contains genuinely tradeable items - never
 * speculative entries for something RePoE knows about but Faustus doesn't currently trade. Unique
 * items (e.g. "Vaal Aspect" base-type jewels like Cooperation - see lib/category-reliability.ts's
 * correctedItemType) are naturally excluded without any special-casing: they aren't stackable/
 * exchange-tradeable in the first place, so they never appear in GGG's exchange data to begin with.
 */
import { CURRENT_LEAGUE } from "../lib/league-recency";

const EXCHANGE_URL = "https://web.poecdn.com/api/currency-exchange";
const REPOE_BASE_ITEMS_URL = "https://repoe-fork.github.io/base_items.json";

interface Market {
  league: string;
  market_pair: [string, string];
}

interface RePoEEntry {
  name: string;
  item_class: string;
  release_state?: string;
}

async function fetchRecentMarkets(league: string): Promise<Market[]> {
  const hourTs = Math.floor(Date.now() / 1000 / 3600) * 3600 - 2 * 3600;
  const res = await fetch(`${EXCHANGE_URL}/${hourTs}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`GGG exchange endpoint returned ${res.status}`);
  const data = (await res.json()) as { markets: Market[] };
  return data.markets.filter((m) => m.league === league);
}

// Item classes actually reachable through Currency Exchange - excludes e.g. "Jewel" (uniques
// aren't exchange-tradeable at all, so this is mostly a defensive filter, not a load-bearing one).
const ELIGIBLE_ITEM_CLASSES = new Set(["Currency", "StackableCurrency", "MapFragment", "DivinationCard"]);

async function main() {
  const league = process.argv[2] || CURRENT_LEAGUE;
  console.log(`Fetching live ${league} exchange markets and RePoE's base item data...`);
  const [markets, repoeRes] = await Promise.all([
    fetchRecentMarkets(league),
    fetch(REPOE_BASE_ITEMS_URL, { headers: { "User-Agent": "Mozilla/5.0" } }),
  ]);
  if (!repoeRes.ok) throw new Error(`RePoE fetch failed: ${repoeRes.status}`);
  const repoe = (await repoeRes.json()) as Record<string, RePoEEntry>;

  const idsSeen = new Set<string>();
  for (const m of markets) for (const id of m.market_pair) idsSeen.add(id);
  console.log(`${idsSeen.size} distinct ids seen in live ${league} exchange data.`);
  console.log(`${Object.keys(repoe).length} entries in RePoE's base_items.json.`);

  const nameToId = new Map<string, string>();
  const collisions: string[] = [];
  const noRepoeEntry: string[] = [];
  const wrongClass: string[] = [];

  for (const id of idsSeen) {
    const entry = repoe[id];
    if (!entry) {
      noRepoeEntry.push(id);
      continue;
    }
    if (!ELIGIBLE_ITEM_CLASSES.has(entry.item_class)) {
      wrongClass.push(`${id} (${entry.item_class})`);
      continue;
    }
    const existingId = nameToId.get(entry.name);
    if (existingId && existingId !== id) {
      collisions.push(`"${entry.name}": ${existingId} vs ${id}`);
      continue;
    }
    nameToId.set(entry.name, id);
  }

  console.log(`\nResolved ${nameToId.size} name->id pairs.`);
  console.log(`${noRepoeEntry.length} ids had no RePoE entry at all (sample):`, noRepoeEntry.slice(0, 10));
  console.log(`${wrongClass.length} ids had an unexpected item_class (sample):`, wrongClass.slice(0, 10));
  if (collisions.length > 0) {
    console.log(`${collisions.length} NAME COLLISIONS (two different ids claim the same name):`);
    collisions.forEach((c) => console.log(" ", c));
  }

  const sorted = [...nameToId.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines = sorted.map(([name, id]) => `  ${JSON.stringify(name)}: ${JSON.stringify(id)},`);
  console.log(`\n=== Generated map (${sorted.length} entries) - review, then paste into lib/faustus.ts ===`);
  console.log(lines.join("\n"));

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
