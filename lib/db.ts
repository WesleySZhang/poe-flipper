import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import path from "node:path";

export const DB_PATH = path.join(process.cwd(), "db", "history.duckdb");

declare global {
  // singleton must survive Next.js dev hot-reloads
  var __duckdbConnection: Promise<DuckDBConnection> | undefined;
}

async function createConnection(): Promise<DuckDBConnection> {
  // fromCache avoids attaching the same file twice if this module is re-evaluated.
  const instance = await DuckDBInstance.fromCache(DB_PATH);
  return instance.connect();
}

/** Shared connection for the whole process; DuckDB only supports one writer per file. */
export function getDb(): Promise<DuckDBConnection> {
  if (!globalThis.__duckdbConnection) {
    globalThis.__duckdbConnection = createConnection();
  }
  return globalThis.__duckdbConnection;
}
