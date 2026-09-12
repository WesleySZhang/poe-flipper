import { DuckDBInstance } from "@duckdb/node-api";
import { config } from "dotenv";
import { glob } from "glob";
import fs from "node:fs";
import path from "node:path";

config({ path: ".env.local" });

const DATA_DIR = process.env.POE_DATA_DIR
  ? path.resolve(process.env.POE_DATA_DIR)
  : path.resolve(process.cwd(), "..", "poe-pricing", "data");

const DB_PATH = path.join(process.cwd(), "db", "history.duckdb");

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(
      `Data directory not found: ${DATA_DIR}. Set POE_DATA_DIR in .env.local to point at the poe.ninja CSV export.`
    );
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  // Each league folder has "<League>.currency.csv" and "<League>.items.csv".
  const csvFiles = await glob("*/*.{currency,items}.csv", { cwd: DATA_DIR, absolute: true });
  if (csvFiles.length === 0) {
    throw new Error(`No CSV files found under ${DATA_DIR}`);
  }

  const instance = await DuckDBInstance.create(DB_PATH);
  const connection = await instance.connect();

  try {
    // currency.csv (Get/Pay exchange pairs) and items.csv (direct chaos value per item) have different schemas.
    await connection.run("DROP TABLE IF EXISTS currency_history");
    await connection.run(`
      CREATE TABLE currency_history (
        league VARCHAR,
        date DATE,
        get VARCHAR,
        pay VARCHAR,
        value DOUBLE,
        confidence VARCHAR
      )
    `);

    await connection.run("DROP TABLE IF EXISTS item_history");
    await connection.run(`
      CREATE TABLE item_history (
        league VARCHAR,
        date DATE,
        item_id BIGINT,
        type VARCHAR,
        name VARCHAR,
        base_type VARCHAR,
        variant VARCHAR,
        links VARCHAR,
        value DOUBLE,
        confidence VARCHAR
      )
    `);

    for (const file of csvFiles) {
      const isItems = file.endsWith(".items.csv");
      const escapedPath = file.replace(/'/g, "''");
      if (isItems) {
        await connection.run(`
          INSERT INTO item_history
          SELECT "League", "Date", "Id", "Type", "Name", "BaseType", "Variant", "Links", "Value", "Confidence"
          FROM read_csv_auto('${escapedPath}', delim=';', header=true, ignore_errors=true)
        `);
      } else {
        await connection.run(`
          INSERT INTO currency_history
          SELECT "League", "Date", "Get", "Pay", "Value", "Confidence"
          FROM read_csv_auto('${escapedPath}', delim=';', header=true, ignore_errors=true)
        `);
      }
      console.log(`Ingested ${path.basename(file)} (${isItems ? "item" : "currency"})`);
    }

    // Populated at runtime by the net-worth "refresh" action; created here so the app can rely on it existing.
    await connection.run(`
      CREATE TABLE IF NOT EXISTS networth_snapshots (
        snapshot_at TIMESTAMP,
        account_name VARCHAR,
        league VARCHAR,
        total_chaos DOUBLE,
        total_divine DOUBLE
      )
    `);

    const currencyCounts = await connection.runAndReadAll(
      "SELECT league, COUNT(*) AS rows FROM currency_history GROUP BY league ORDER BY league"
    );
    console.table(currencyCounts.getRowObjects());

    const itemCounts = await connection.runAndReadAll(
      "SELECT league, COUNT(*) AS rows FROM item_history GROUP BY league ORDER BY league"
    );
    console.table(itemCounts.getRowObjects());
  } finally {
    connection.disconnectSync();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
