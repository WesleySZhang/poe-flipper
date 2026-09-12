import "server-only";
import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";

export interface SessionData {
  accountName?: string;
  poesessid?: string;
  league?: string;
}

const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? "",
  cookieName: "poe-trade-assistant-session",
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  },
};

export async function getSession() {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is not set. Copy .env.local.example to .env.local and fill it in.");
  }
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}
