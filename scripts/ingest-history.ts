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
  // Start from a clean file every run - this script always fully rebuilds everything from the CSVs
  // anyway, and dropping tables later (to shrink the shipped DB, see below) doesn't reclaim space
  // in an existing file without an explicit compaction step, so it's simplest to just not carry one.
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(`${DB_PATH}.wal`, { force: true });

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

  // Raw ingestion happens entirely in memory - DuckDB's DROP TABLE doesn't reclaim on-disk space
  // (there's no VACUUM-equivalent compaction), so building the ~250MB raw tables directly in the
  // destination file and then dropping them just leaves that space allocated but unused, growing
  // the file instead of shrinking it. Only the compact, day-aggregated tables ever get written to
  // DB_PATH (see the ATTACH block below), so the on-disk file reflects only what's actually there.
  const instance = await DuckDBInstance.create(":memory:");
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

    const currencyCounts = await connection.runAndReadAll(
      "SELECT league, COUNT(*) AS rows FROM currency_history GROUP BY league ORDER BY league"
    );
    console.table(currencyCounts.getRowObjects());

    const itemCounts = await connection.runAndReadAll(
      "SELECT league, COUNT(*) AS rows FROM item_history GROUP BY league ORDER BY league"
    );
    console.table(itemCounts.getRowObjects());

    // The app only ever queries one row per (league, name[, variant], day) - never the raw
    // per-listing history - so that's the only form worth shipping. Building it once here (instead
    // of materializing it at query time, as a previous version of this app did) means: (1) the
    // deployed DB is a fraction of the raw ingested size (dropping the raw tables below reclaims
    // that space, since this is always a freshly-created file - see above), and (2) the app has one
    // less cold-start cost, since there's no first-query aggregation step left to pay.
    console.log("Building day-aggregated tables...");

    await connection.run(`
      CREATE TABLE currency_history_dayed AS
      WITH daily AS (
        SELECT league, get AS name, date, AVG(value) AS value
        FROM currency_history
        WHERE pay = 'Chaos Orb' AND get != 'Chaos Orb' AND confidence = 'High'
        GROUP BY league, get, date
      ),
      league_start AS (
        SELECT league, MIN(date) AS start_date FROM daily GROUP BY league
      )
      SELECT d.league, d.name, d.value, date_diff('day', ls.start_date, d.date) AS day_offset
      FROM daily d JOIN league_start ls ON d.league = ls.league
    `);
    await connection.run(`
      CREATE TABLE item_history_dayed AS
      WITH combined AS (
        -- A linked item prices completely differently from an unlinked one (a 6-link is a
        -- different item to trade, not just a variant of the same one) - fold the links bucket
        -- ("1-4 links"/"5 links"/"6 links") into the variant discriminator so it gets grouped and
        -- matched separately everywhere downstream, and displays as "Name (6 links)" the same way
        -- an existing gem/quality variant already does.
        SELECT
          league, name, date, type, value,
          CASE
            WHEN links IS NOT NULL AND variant IS NOT NULL THEN variant || ', ' || links
            WHEN links IS NOT NULL THEN links
            ELSE variant
          END AS variant
        FROM item_history
        WHERE confidence = 'High'
      ),
      daily AS (
        SELECT league, name, variant, date, AVG(value) AS value, ANY_VALUE(type) AS type
        FROM combined
        GROUP BY league, name, variant, date
      ),
      league_start AS (
        SELECT league, MIN(date) AS start_date FROM daily GROUP BY league
      )
      SELECT d.league, d.name, d.variant, d.value, d.type, date_diff('day', ls.start_date, d.date) AS day_offset
      FROM daily d JOIN league_start ls ON d.league = ls.league
    `);

    // Chaos is a moving yardstick: Divine Orb went from 36c to 295c over Mirage's first 30 days, so
    // an item holding steady at "2 divines" all league still looks like an 8x chaos winner. This
    // per-league-day rate lets queries divide that debasement out and measure real value change
    // (see growth-ratios.ts). Kept as a tiny lookup table joined at query time rather than a divine
    // column on every row - a few hundred rows here versus ~45MB of extra file there, which matters
    // for staying inside Vercel's function bundle limit. Derived from the dayed table above so it
    // shares exactly the same day_offset convention.
    await connection.run(`
      CREATE TABLE divine_rate_dayed AS
      SELECT league, day_offset, value AS chaos_per_divine
      FROM currency_history_dayed
      WHERE name = 'Divine Orb' AND value > 0
    `);

    const dayedCounts = await connection.runAndReadAll(`
      SELECT 'currency_history_dayed' AS table_name, COUNT(*) AS rows FROM currency_history_dayed
      UNION ALL
      SELECT 'item_history_dayed', COUNT(*) FROM item_history_dayed
      UNION ALL
      SELECT 'divine_rate_dayed', COUNT(*) FROM divine_rate_dayed
    `);
    console.table(dayedCounts.getRowObjects());

    // Only the two compact tables above ever touch disk - attach the (freshly created, empty)
    // destination file and copy just those into it, leaving the raw in-memory tables behind.
    const escapedDbPath = DB_PATH.replace(/'/g, "''");
    await connection.run(`ATTACH '${escapedDbPath}' AS out`);
    await connection.run("CREATE TABLE out.currency_history_dayed AS SELECT * FROM currency_history_dayed");
    await connection.run("CREATE TABLE out.item_history_dayed AS SELECT * FROM item_history_dayed");
    await connection.run("CREATE TABLE out.divine_rate_dayed AS SELECT * FROM divine_rate_dayed");
    await connection.run("DETACH out");
  } finally {
    connection.disconnectSync();
  }

  const { size } = fs.statSync(DB_PATH);
  console.log(`Final database size: ${(size / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
