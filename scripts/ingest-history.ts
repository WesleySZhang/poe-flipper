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

// Restricting to the last handful of leagues trades away data volume for data quality - older
// leagues' price history is noisier/less complete, and league-recency weighting (see
// league-recency.ts) already discounts old leagues heavily, so keeping them around was mostly
// just adding stale signal the model had to average away.
const INCLUDED_LEAGUES = ["Mirage", "Keepers", "Mercenaries", "Settlers", "Phrecia 2.0"];

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(
      `Data directory not found: ${DATA_DIR}. Set POE_DATA_DIR in .env.local to point at the poe.ninja CSV export.`
    );
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  // Each league folder has "<League>.currency.csv" and "<League>.items.csv".
  const allCsvFiles = await glob("*/*.{currency,items}.csv", { cwd: DATA_DIR, absolute: true });
  if (allCsvFiles.length === 0) {
    throw new Error(`No CSV files found under ${DATA_DIR}`);
  }
  const csvFiles = allCsvFiles.filter((file) => INCLUDED_LEAGUES.includes(path.basename(path.dirname(file))));
  const missingLeagues = INCLUDED_LEAGUES.filter(
    (league) => !csvFiles.some((file) => path.basename(path.dirname(file)) === league)
  );
  if (missingLeagues.length > 0) {
    throw new Error(`No CSV files found for league(s): ${missingLeagues.join(", ")} under ${DATA_DIR}`);
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

    // Leftover from the removed net-worth-tracking feature - drop it if an older DB still has it.
    await connection.run("DROP TABLE IF EXISTS networth_snapshots");

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
