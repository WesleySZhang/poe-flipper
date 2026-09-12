"use server";

import { getSession } from "@/lib/session";
import { getAllStashItems, PoeAuthError } from "@/lib/poe-legacy-client";
import { getAllCurrentCurrencyPrices, getAllCurrentItemPrices } from "@/lib/poe-ninja";
import { computeNetWorth, type NetWorthResult } from "@/lib/networth";
import { getDb } from "@/lib/db";

export type RefreshNetWorthResult = { ok: true; result: NetWorthResult } | { ok: false; error: string };

export async function refreshNetWorth(): Promise<RefreshNetWorthResult> {
  const session = await getSession();
  if (!session.accountName || !session.poesessid || !session.league) {
    return { ok: false, error: "Not logged in." };
  }

  try {
    const [items, currencyPrices, itemPrices] = await Promise.all([
      getAllStashItems(session.accountName, session.poesessid, session.league),
      getAllCurrentCurrencyPrices(session.league),
      getAllCurrentItemPrices(session.league),
    ]);

    const result = computeNetWorth(items, currencyPrices, itemPrices);

    const db = await getDb();
    await db.run(
      `INSERT INTO networth_snapshots (snapshot_at, account_name, league, total_chaos, total_divine)
       VALUES (now(), $accountName, $league, $totalChaos, $totalDivine)`,
      {
        accountName: session.accountName,
        league: session.league,
        totalChaos: result.totalChaos,
        totalDivine: result.totalDivine,
      }
    );

    return { ok: true, result };
  } catch (err) {
    if (err instanceof PoeAuthError) {
      return { ok: false, error: err.message };
    }
    console.error("refreshNetWorth failed", err);
    return { ok: false, error: "Failed to refresh net worth. Please try again." };
  }
}

export interface NetWorthSnapshotPoint {
  snapshotAt: string;
  totalChaos: number;
  totalDivine: number;
}

export async function getNetWorthHistory(): Promise<NetWorthSnapshotPoint[]> {
  const session = await getSession();
  if (!session.accountName || !session.league) return [];

  const db = await getDb();
  const reader = await db.runAndReadAll(
    `SELECT snapshot_at, total_chaos, total_divine FROM networth_snapshots
     WHERE account_name = $accountName AND league = $league
     ORDER BY snapshot_at ASC`,
    { accountName: session.accountName, league: session.league }
  );
  return reader.getRowObjects().map((row) => ({
    snapshotAt: String(row.snapshot_at),
    totalChaos: Number(row.total_chaos),
    totalDivine: Number(row.total_divine),
  }));
}
