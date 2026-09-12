import "server-only";

const USER_AGENT = "poe-trade-assistant/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
const BASE_URL = "https://www.pathofexile.com/character-window/get-stash-items";

export interface LegacyStashTabMeta {
  id: string;
  name: string;
  index: number;
  type: string;
}

export interface LegacyStashItem {
  name?: string;
  typeLine: string;
  baseType?: string;
  stackSize?: number;
  frameType?: number;
}

export class PoeAuthError extends Error {}

async function legacyRequest(
  accountName: string,
  poesessid: string,
  league: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const url = new URL(BASE_URL);
  url.searchParams.set("accountName", accountName);
  url.searchParams.set("league", league);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: `POESESSID=${poesessid}`,
    },
    cache: "no-store",
  });

  if (res.status === 401 || res.status === 403) {
    throw new PoeAuthError("Invalid or expired POESESSID / account name.");
  }
  if (!res.ok) {
    throw new Error(`Stash request failed (${res.status})`);
  }

  return (await res.json()) as Record<string, unknown>;
}

/** Lists stash tab metadata (name/index/type) without fetching item contents. */
export async function listStashTabs(
  accountName: string,
  poesessid: string,
  league: string
): Promise<LegacyStashTabMeta[]> {
  const data = await legacyRequest(accountName, poesessid, league, { tabs: "1" });
  const tabs = (data.tabs as Array<Record<string, unknown>> | undefined) ?? [];
  return tabs
    .filter((tab) => tab.type !== "Folder")
    .map((tab) => ({
      id: String(tab.id),
      name: String(tab.n),
      index: Number(tab.i),
      type: String(tab.type),
    }));
}

/** Fetches the item contents of a single stash tab by its index. */
export async function getStashTabItems(
  accountName: string,
  poesessid: string,
  league: string,
  tabIndex: number
): Promise<LegacyStashItem[]> {
  const data = await legacyRequest(accountName, poesessid, league, { tabIndex: String(tabIndex) });
  return (data.items as LegacyStashItem[] | undefined) ?? [];
}

/** Fetches every non-folder stash tab's items sequentially (avoids bursting the legacy endpoint). */
export async function getAllStashItems(
  accountName: string,
  poesessid: string,
  league: string
): Promise<LegacyStashItem[]> {
  const tabs = await listStashTabs(accountName, poesessid, league);
  const allItems: LegacyStashItem[] = [];
  for (const tab of tabs) {
    const items = await getStashTabItems(accountName, poesessid, league, tab.index);
    allItems.push(...items);
  }
  return allItems;
}
