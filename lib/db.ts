import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import path from "node:path";

// Override lets a discovery script point at an experimental DB (e.g. one built with extra
// candidate training leagues via scripts/ingest-history.ts's own POE_DB_PATH override) without
// touching the real db/history.duckdb the deployed app and dev server both read from.
export const DB_PATH = process.env.POE_DB_PATH
  ? path.resolve(process.env.POE_DB_PATH)
  : path.join(process.cwd(), "db", "history.duckdb");

declare global {
  // singleton must survive Next.js dev hot-reloads
  var __duckdbConnection: Promise<DuckDBConnection> | undefined;
}

async function createConnection(): Promise<DuckDBConnection> {
  // The app only ever reads this file - all writes happen offline via `npm run db:ingest`, which
  // opens its own separate connection - so open read-only. This is required on Vercel (its
  // deployed function filesystem is read-only outside /tmp; the default read-write open mode fails
  // there with "Read-only file system" since DuckDB needs write access to take its file lock), and
  // as a bonus, read-only connections don't take that lock at all, so this also lets a local script
  // (e.g. the backtest) run against the file at the same time as the dev server without conflict.
  const instance = await DuckDBInstance.fromCache(DB_PATH, { access_mode: "READ_ONLY" });
  return instance.connect();
}

/** Shared connection for the whole process; DuckDB only supports one writer per file. */
export function getDb(): Promise<DuckDBConnection> {
  if (!globalThis.__duckdbConnection) {
    globalThis.__duckdbConnection = createConnection();
  }
  return globalThis.__duckdbConnection;
}
