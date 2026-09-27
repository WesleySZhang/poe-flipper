/**
 * Shared pieces for the scripts that keep this app's generated/hand-kept item lists current:
 * scripts/generate-faustus-mapping.ts, scripts/generate-divination-cards.ts and
 * scripts/check-new-items.ts (the daily job that runs them all and opens a PR).
 *
 * Three external sources:
 *  - RePoE's base_items.json (a community dump of PoE's game files): item names, GGG ids, card stack
 *    sizes and rewards.
 *  - GGG's Currency Exchange API: which ids have an open market right now.
 *  - poe.ninja's own category config, read out of its site JavaScript (see fetchNinjaCategories).
 *
 * Not part of the running app.
 */
import fs from "node:fs";
import path from "node:path";

const REPOE_BASE_ITEMS_URL = "https://repoe-fork.github.io/base_items.json";
const EXCHANGE_URL = "https://web.poecdn.com/api/currency-exchange";
const USER_AGENT = "Mozilla/5.0";

export const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------------------------
// RePoE

export interface RePoEEntry {
  name: string;
  item_class: string;
  release_state?: string;
  properties?: { stack_size?: number; description?: string };
}

export async function fetchRePoEBaseItems(): Promise<Record<string, RePoEEntry>> {
  const res = await fetch(REPOE_BASE_ITEMS_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`RePoE fetch failed: ${res.status}`);
  return (await res.json()) as Record<string, RePoEEntry>;
}

// ---------------------------------------------------------------------------------------------
// Currency Exchange name map (lib/faustus.ts's FAUSTUS_NAME_TO_ID)

interface Market {
  league: string;
  market_pair: [string, string];
}

/** Every GGG id with an open market in `league` in a recent closed hour. The latest hours can still
 *  be missing, so a few are tried. */
export async function fetchExchangeIds(league: string): Promise<Set<string>> {
  const nowHour = Math.floor(Date.now() / 1000 / 3600) * 3600;
  let lastStatus = 0;
  for (const hoursBack of [2, 3, 4]) {
    const res = await fetch(`${EXCHANGE_URL}/${nowHour - hoursBack * 3600}`, { headers: { "User-Agent": USER_AGENT } });
    lastStatus = res.status;
    if (!res.ok) continue;
    const data = (await res.json()) as { markets: Market[] };
    const ids = new Set<string>();
    for (const m of data.markets) if (m.league === league) for (const id of m.market_pair) ids.add(id);
    if (ids.size > 0) return ids;
  }
  throw new Error(`GGG exchange endpoint returned no ${league} markets (last status ${lastStatus})`);
}

// Classes reachable through the Currency Exchange - uniques never are, so this is mostly defensive.
const ELIGIBLE_ITEM_CLASSES = new Set(["Currency", "StackableCurrency", "MapFragment", "DivinationCard"]);

export interface FaustusMapResult {
  nameToId: Map<string, string>;
  noRepoeEntry: string[];
  wrongClass: string[];
  collisions: string[];
}

/** Resolves every exchange id to its display name via RePoE (scoped to ids actually traded). */
export function buildFaustusMap(repoe: Record<string, RePoEEntry>, idsSeen: Set<string>): FaustusMapResult {
  const nameToId = new Map<string, string>();
  const noRepoeEntry: string[] = [];
  const wrongClass: string[] = [];
  const collisions: string[] = [];
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
  return { nameToId, noRepoeEntry, wrongClass, collisions };
}

export const FAUSTUS_PATH = path.join(ROOT, "lib", "faustus.ts");
const FAUSTUS_START = "export const FAUSTUS_NAME_TO_ID: Readonly<Record<string, string>> = {";

/** The map as currently written in lib/faustus.ts (read as text - that module is server-only). */
export function readFaustusMap(): Map<string, string> {
  const body = readBlock(FAUSTUS_PATH, FAUSTUS_START, "\n};");
  const map = new Map<string, string>();
  for (const m of body.matchAll(/^\s+("(?:[^"\\]|\\.)*"):\s*("(?:[^"\\]|\\.)*"),?\s*$/gm)) {
    map.set(JSON.parse(m[1]), JSON.parse(m[2]));
  }
  return map;
}

export function formatFaustusEntries(map: Map<string, string>): string {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, id]) => `  ${JSON.stringify(name)}: ${JSON.stringify(id)},`)
    .join("\n");
}

export function writeFaustusMap(map: Map<string, string>): boolean {
  return replaceBlock(FAUSTUS_PATH, FAUSTUS_START, "\n};", `\n${formatFaustusEntries(map)}`);
}

// ---------------------------------------------------------------------------------------------
// Divination cards (lib/divination-cards.ts's DIVINATION_CARDS)

type RewardKind = "unique" | "currency" | "card";

export interface DivinationCardDef {
  name: string;
  stackSize: number;
  rewardKind: RewardKind;
  rewardName: string;
  rewardQuantity: number;
}

const DIVINATION_CARD_PREFIX = "Metadata/Items/DivinationCards/";
const ABSTRACT_DIVINATION_CARD_ID = `${DIVINATION_CARD_PREFIX}AbstractDivinationCard`;

// whiteitem/magicitem/rareitem are priced as their plain base type - see generate-divination-cards.ts.
const REWARD_TAG_TO_KIND: Record<string, RewardKind> = {
  uniqueitem: "unique",
  currencyitem: "currency",
  divination: "card",
  whiteitem: "currency",
  magicitem: "currency",
  rareitem: "currency",
};

// Known reward tags that are skipped on purpose: gem rewards are random gems or a level/quality
// variant this list doesn't model. Anything not here or in REWARD_TAG_TO_KIND is reported as new.
const SKIPPED_REWARD_TAGS = new Set(["gemitem"]);

// "3x Chaos Orb" -> 3 x "Chaos Orb"; "1,500x ..." -> 1500; no prefix -> 1.
const QUANTITY_PREFIX = /^([\d,]+)x (.+)$/;

export interface DivinationCardsResult {
  cards: DivinationCardDef[];
  total: number;
  noStackSize: number;
  noSingleTag: number;
  /** Cards skipped for a reward tag that isn't supported (known-skipped ones included). */
  unknownTag: number;
  /** Cards skipped for a reward tag nobody has looked at yet, as "Card (tag: text)". */
  unknownTagCards: string[];
}

/** Only cards whose reward is exactly one <tag>{text} segment - see generate-divination-cards.ts. */
export function buildDivinationCards(repoe: Record<string, RePoEEntry>): DivinationCardsResult {
  const entries = Object.entries(repoe).filter(
    ([id, e]) => id.startsWith(DIVINATION_CARD_PREFIX) && id !== ABSTRACT_DIVINATION_CARD_ID && e.item_class === "DivinationCard"
  );
  const cards: DivinationCardDef[] = [];
  let noStackSize = 0;
  let noSingleTag = 0;
  let unknownTag = 0;
  const unknownTagCards: string[] = [];
  for (const [, entry] of entries) {
    const stackSize = entry.properties?.stack_size;
    if (!stackSize || stackSize < 1) {
      noStackSize++;
      continue;
    }
    const parts = [...(entry.properties?.description ?? "").matchAll(/<(\w+)>\{([^}]*)\}/g)];
    if (parts.length !== 1) {
      noSingleTag++;
      continue;
    }
    const [, tag, text] = parts[0];
    const rewardKind = REWARD_TAG_TO_KIND[tag];
    if (!rewardKind) {
      unknownTag++;
      if (!SKIPPED_REWARD_TAGS.has(tag)) unknownTagCards.push(`${entry.name} (${tag}: ${text})`);
      continue;
    }
    const q = text.match(QUANTITY_PREFIX);
    cards.push({
      name: entry.name,
      stackSize,
      rewardKind,
      rewardName: q ? q[2] : text,
      rewardQuantity: q ? Number(q[1].replace(/,/g, "")) : 1,
    });
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));
  return { cards, total: entries.length, noStackSize, noSingleTag, unknownTag, unknownTagCards };
}

export const DIVINATION_CARDS_PATH = path.join(ROOT, "lib", "divination-cards.ts");
const CARDS_START = "export const DIVINATION_CARDS: readonly DivinationCardDef[] = [";
const CARDS_END = "\n] as const;";

export function readDivinationCardNames(): string[] {
  const body = readBlock(DIVINATION_CARDS_PATH, CARDS_START, CARDS_END);
  return [...body.matchAll(/\{ name: ("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]));
}

export function formatCardLines(cards: DivinationCardDef[]): string {
  return cards
    .map(
      (c) =>
        `  { name: ${JSON.stringify(c.name)}, stackSize: ${c.stackSize}, rewardKind: ${JSON.stringify(c.rewardKind)}, rewardName: ${JSON.stringify(c.rewardName)}, rewardQuantity: ${c.rewardQuantity} },`
    )
    .join("\n");
}

export function writeDivinationCards(cards: DivinationCardDef[]): boolean {
  return replaceBlock(DIVINATION_CARDS_PATH, CARDS_START, CARDS_END, `\n${formatCardLines(cards)}`);
}

// ---------------------------------------------------------------------------------------------
// poe.ninja categories

export interface NinjaCategory {
  /** The API's type name, e.g. "DivinationCard". */
  type: string;
  /** The site's URL slug, e.g. "divination-cards". */
  url: string;
  /** "exchange" and/or "stash" - which overview endpoint serves it. */
  views: string[];
}

const NINJA_PAGE = "https://poe.ninja/poe1/economy";
const NINJA_ASSETS = "https://assets.poe.ninja/_astro/";

/**
 * poe.ninja has no API listing its categories; its site builds the sidebar from a config object
 * compiled into one of its JavaScript chunks: `{availableViews:[...], ..., title:`X`, type:`Y`,
 * url:`z`}` per category. Chunk names change on every deploy, so this walks the import graph from
 * the page's entry modules (breadth-first, in parallel) until it finds that chunk - about 50 files
 * and 2 seconds. Object keys survive minification, which is what makes the parse stable.
 *
 * Throws if the result looks wrong (too few categories, or no DivinationCard) rather than returning
 * something a caller would act on.
 */
export async function fetchNinjaCategories(league: string): Promise<NinjaCategory[]> {
  const html = await (await fetch(`${NINJA_PAGE}/${league.toLowerCase()}/currency`, { headers: { "User-Agent": USER_AGENT } })).text();
  let frontier = [...new Set([...html.matchAll(/_astro\/([A-Za-z0-9_.-]+\.mjs)/g)].map((m) => m[1]))];
  const seen = new Set<string>();
  let config: string | undefined;
  while (frontier.length > 0 && !config && seen.size < 1000) {
    const batch = frontier.filter((f) => !seen.has(f));
    batch.forEach((f) => seen.add(f));
    const texts = await Promise.all(
      batch.map((f) =>
        fetch(NINJA_ASSETS + f, { headers: { "User-Agent": USER_AGENT } })
          .then((r) => (r.ok ? r.text() : ""))
          .catch(() => "")
      )
    );
    const next = new Set<string>();
    texts.forEach((t) => {
      if (/availableViews:\[/.test(t) && /type:`DivinationCard`,url:`/.test(t)) config = t;
      for (const m of t.matchAll(/["'`](?:\.\/)?([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.mjs)["'`]/g)) {
        if (!seen.has(m[1])) next.add(m[1]);
      }
    });
    frontier = [...next];
  }
  if (!config) throw new Error(`poe.ninja category config not found after reading ${seen.size} script files`);

  const categories: NinjaCategory[] = [];
  for (const m of config.matchAll(/type:`([^`]+)`,url:`([^`]+)`/g)) {
    const before = config.slice(Math.max(0, (m.index ?? 0) - 2000), m.index);
    const viewsAt = before.lastIndexOf("availableViews:[");
    const views =
      viewsAt >= 0
        ? before
            .slice(viewsAt + "availableViews:[".length, before.indexOf("]", viewsAt))
            .split(",")
            .map((v) => v.replace(/[`'"\s]/g, ""))
            .filter(Boolean)
        : [];
    if (!categories.some((c) => c.type === m[1])) categories.push({ type: m[1], url: m[2], views });
  }
  if (categories.length < 30 || !categories.some((c) => c.type === "DivinationCard")) {
    throw new Error(`poe.ninja category config parsed to ${categories.length} categories - the site's format probably changed`);
  }
  return categories;
}

// ---------------------------------------------------------------------------------------------
// File editing

function readText(file: string): { text: string; crlf: boolean } {
  const raw = fs.readFileSync(file, "utf8");
  const crlf = raw.includes("\r\n");
  return { text: crlf ? raw.replace(/\r\n/g, "\n") : raw, crlf };
}

function writeText(file: string, text: string, crlf: boolean): boolean {
  const out = crlf ? text.replace(/\n/g, "\r\n") : text;
  if (fs.readFileSync(file, "utf8") === out) return false;
  fs.writeFileSync(file, out);
  return true;
}

/** The text between `start` and the first `end` after it. */
export function readBlock(file: string, start: string, end: string): string {
  const { text } = readText(file);
  const a = text.indexOf(start);
  if (a === -1) throw new Error(`${file}: "${start}" not found`);
  const b = text.indexOf(end, a + start.length);
  if (b === -1) throw new Error(`${file}: end of block after "${start}" not found`);
  return text.slice(a + start.length, b);
}

/** Replaces the text between `start` and the first `end` after it. Returns whether the file changed. */
export function replaceBlock(file: string, start: string, end: string, body: string): boolean {
  const { text, crlf } = readText(file);
  const a = text.indexOf(start);
  if (a === -1) throw new Error(`${file}: "${start}" not found`);
  const b = text.indexOf(end, a + start.length);
  if (b === -1) throw new Error(`${file}: end of block after "${start}" not found`);
  return writeText(file, text.slice(0, a + start.length) + body + text.slice(b), crlf);
}

/** Inserts `lines` just before the first `end` after `start` (appending to a list). */
export function insertBeforeBlockEnd(file: string, start: string, end: string, lines: string[]): boolean {
  if (lines.length === 0) return false;
  const { text, crlf } = readText(file);
  const a = text.indexOf(start);
  if (a === -1) throw new Error(`${file}: "${start}" not found`);
  const b = text.indexOf(end, a + start.length);
  if (b === -1) throw new Error(`${file}: end of block after "${start}" not found`);
  return writeText(file, text.slice(0, b) + lines.map((l) => `\n${l}`).join("") + text.slice(b), crlf);
}
