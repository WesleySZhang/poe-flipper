"use server";

import { getSession } from "@/lib/session";

export interface LoginInput {
  accountName: string;
  poesessid: string;
  league: string;
}

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function login(input: LoginInput): Promise<LoginResult> {
  const accountName = input.accountName.trim();
  const poesessid = input.poesessid.trim();
  const league = input.league.trim();

  if (!accountName || !poesessid || !league) {
    return { ok: false, error: "Account name, POESESSID, and league are all required." };
  }

  const session = await getSession();
  session.accountName = accountName;
  session.poesessid = poesessid;
  session.league = league;
  await session.save();

  return { ok: true };
}

export async function logout(): Promise<void> {
  const session = await getSession();
  session.destroy();
}

export interface SessionState {
  loggedIn: boolean;
  accountName?: string;
  league?: string;
}

// Never return poesessid to the client - it stays server-side only.
export async function getSessionState(): Promise<SessionState> {
  const session = await getSession();
  return {
    loggedIn: Boolean(session.accountName && session.poesessid && session.league),
    accountName: session.accountName,
    league: session.league,
  };
}
