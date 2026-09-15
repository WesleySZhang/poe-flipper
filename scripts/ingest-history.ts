import { DuckDBInstance, type DuckDBConnection, type DuckDBDateValue } from "@duckdb/node-api";
import { config } from "dotenv";
import { glob } from "glob";
import fs from "node:fs";
import path from "node:path";

config({ path: ".env.local" });

const DATA_DIR = process.env.POE_DATA_DIR
  ? path.resolve(process.env.POE_DATA_DIR)
  : path.resolve(process.cwd(), "..", "poe-pricing", "data");

// Override lets a discovery run build a separate experimental DB (e.g. with extra candidate
// training leagues included) without touching the real file the app/backtest read by default -
// see the matching override in lib/db.ts.
const DB_PATH = process.env.POE_DB_PATH
  ? path.resolve(process.env.POE_DB_PATH)
  : path.join(process.cwd(), "db", "history.duckdb");

// Restricting to the last handful of leagues trades away data volume for data quality - older
// leagues' price history is noisier/less complete, and league-recency weighting (see
// league-recency.ts) already discounts old leagues heavily, so keeping them around was mostly
// just adding stale signal the model had to average away. Phrecia 2.0 was excluded for a while
// (it's a short event league, not a normal challenge league economy) after a data glitch traced
// back to it - re-included now that the currency/item magnitude sanity checks below have both been
// hardened enough to catch that specific class of bug (verified against the actual glitch that
// prompted the exclusion). Plain "Phrecia" (the original, non-2.0 event) stays out - noisier and
// never included to begin with.
const INCLUDED_LEAGUES = ["Mirage", "Keepers", "Mercenaries", "Settlers", "Phrecia 2.0"];

// Each main league folder can also have an "extras" subfolder holding private/community leagues
// that ran during that league's era (streamer leagues, restart leagues, "search party" events,
// etc.) - smaller player bases, so a less liquid, potentially noisier economy of their own. Checked
// all 21 across Keepers/Mercenaries/Mirage/Settlers: poe.ninja recorded literally zero price rows
// for 20 of them (header-only CSVs - too few trades to ever produce a snapshot), leaving exactly one
// with real, substantial data - Necro Settlers (~105 days, ~20% of main Settlers' row volume).
//
// Tested it as additional training data anyway (scripts/backtest-extras-leagues.ts, run against a
// separate experimental DB via the POE_DB_PATH override below - never against the real production
// DB) across two holdout leagues (Mirage, Phrecia 2.0), at full weight, half weight, and as a
// substitute for main Settlers: every configuration that included it was flat-to-worse than the
// current 5-league baseline on both Spearman correlation and directional accuracy, driven mostly by
// a sharp Essence-category regression (-0.22 Spearman on ~5900 pooled rows) that outweighed a few
// small gains elsewhere (IncursionTemple, Vial, Fossil). As a standalone single-league predictor it
// also transferred worse than mainline Settlers alone - consistent with it being a smaller, less
// liquid economy of its own rather than a noisier sample of the same one. Left out of production
// training as a result - this allowlist stays empty until a future extras drop earns a spot in it
// the same way (glob is exercised either way so the mechanism itself stays tested).
const INCLUDED_EXTRA_LEAGUES: string[] = [];

// One-day "spike" glitches: a steady price suddenly drops (or jumps) to a small fraction/multiple
// of itself for exactly one day, then returns to right around its former level and keeps trending
// the way it already was. Distinct from the magnitude-band and local-median rejection above (which
// throw the bad day away entirely, leaving a gap) - this instead guesses the value that day
// probably should have been, by log-linearly interpolating between the surviving day right before
// and right after it, so a chart or a growth-ratio training window sees a smooth curve instead of a
// spike. Applied as a post-process on top of the tables above, after their own filtering has
// already run, since a spike can slip through those unrejected (they anchor against a wide 5x band
// or a +/-25-day window median, not the immediate neighboring days).
//
// Tuned and spot-checked against the real production DB (db/history.duckdb) before landing:
//   - Requiring BOTH neighbors to sit within 60% of each other ("steady") is what tells a real,
//     sustained crash/rally apart from a one-day blip - a persisting regime change fails this check
//     (the "after" side never comes back close to the "before" side) and is correctly left alone.
//     Verified this against two real multi-day crashes found in Keepers (Annulment Shard,
//     Al-Hezmin's Crest) that a naive "far from local-interpolated line" check wrongly flagged -
//     neither is flagged once this steady-neighbor requirement is added.
//   - Requiring the flagged day to be at least 2x away from BOTH neighbors, in the same direction
//     (a clean V or inverted-V), caught 475 currency rows and 18516 item rows out of ~8.4M total
//     rows (~0.2%) - a small, targeted slice, not a broad rewrite of the dataset.
const SPIKE_RATIO_THRESHOLD = 2.0;
const SPIKE_NEIGHBOR_STEADY_TOLERANCE = 1.6;
const SPIKE_MAX_NEIGHBOR_GAP_DAYS = 6;

interface SpikeRow {
  league: string;
  name: string;
  variant: string | null;
  dayOffset: number;
  value: number;
}

interface SpikeCorrection extends SpikeRow {
  originalValue: number;
}

function detectSpikeCorrections(rows: SpikeRow[]): SpikeCorrection[] {
  const corrections: SpikeCorrection[] = [];
  const groups = new Map<string, SpikeRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.league, row.name, row.variant]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const lnSpike = Math.log(SPIKE_RATIO_THRESHOLD);
  const lnSteady = Math.log(SPIKE_NEIGHBOR_STEADY_TOLERANCE);
  for (const group of groups.values()) {
    // group is already in day_offset order (rows were fetched pre-sorted) - each candidate is
    // checked against its immediate, real (uncorrected) neighbors, not a running/adjusted value, so
    // two adjacent spike days each get judged independently off their own actual surroundings.
    for (let i = 1; i < group.length - 1; i++) {
      const prev = group[i - 1];
      const cur = group[i];
      const next = group[i + 1];
      const gap = next.dayOffset - prev.dayOffset;
      if (gap <= 0 || gap > SPIKE_MAX_NEIGHBOR_GAP_DAYS) continue;
      if (prev.value <= 0 || cur.value <= 0 || next.value <= 0) continue;
      const lnPrev = Math.log(prev.value);
      const lnCur = Math.log(cur.value);
      const lnNext = Math.log(next.value);
      const drift = lnNext - lnPrev;
      if (Math.abs(drift) > lnSteady) continue;
      const devPrev = lnCur - lnPrev;
      const devNext = lnCur - lnNext;
      const sameSign = (devPrev > 0 && devNext > 0) || (devPrev < 0 && devNext < 0);
      if (!sameSign || Math.min(Math.abs(devPrev), Math.abs(devNext)) < lnSpike) continue;
      const t = (cur.dayOffset - prev.dayOffset) / gap;
      const interpolated = Math.exp(lnPrev + t * drift);
      corrections.push({ ...cur, value: interpolated, originalValue: cur.value });
    }
  }
  return corrections;
}

/** Runs the spike check above against one dayed table and writes any corrected values back into it. */
async function correctSpikesInTable(
  connection: DuckDBConnection,
  table: "currency_history_dayed" | "item_history_dayed",
  hasVariant: boolean
): Promise<void> {
  const variantSelect = hasVariant ? "variant" : "NULL AS variant";
  const orderBy = hasVariant ? "league, name, variant, day_offset" : "league, name, day_offset";
  const reader = await connection.runAndReadAll(
    `SELECT league, name, ${variantSelect}, day_offset, value FROM ${table} ORDER BY ${orderBy}`
  );
  const rows: SpikeRow[] = reader.getRowObjects().map((row) => ({
    league: String(row.league),
    name: String(row.name),
    variant: row.variant === null || row.variant === undefined ? null : String(row.variant),
    dayOffset: Number(row.day_offset),
    value: Number(row.value),
  }));

  const corrections = detectSpikeCorrections(rows);
  console.log(`Spike correction: ${corrections.length} of ${rows.length} rows corrected in ${table}`);
  if (corrections.length === 0) return;

  console.table(
    corrections.slice(0, 10).map((c) => ({
      league: c.league,
      name: hasVariant && c.variant ? `${c.name} (${c.variant})` : c.name,
      day: c.dayOffset,
      was: c.originalValue,
      now: Number(c.value.toFixed(4)),
    }))
  );

  await connection.run("DROP TABLE IF EXISTS spike_corrections");
  await connection.run(
    "CREATE TABLE spike_corrections (league VARCHAR, name VARCHAR, variant VARCHAR, day_offset BIGINT, new_value DOUBLE)"
  );
  const appender = await connection.createAppender("spike_corrections");
  for (const c of corrections) {
    appender.appendVarchar(c.league);
    appender.appendVarchar(c.name);
    if (c.variant === null) appender.appendNull();
    else appender.appendVarchar(c.variant);
    appender.appendBigInt(BigInt(c.dayOffset));
    appender.appendDouble(c.value);
    appender.endRow();
  }
  appender.closeSync();

  const variantJoinClause = hasVariant ? "AND t.variant IS NOT DISTINCT FROM c.variant" : "";
  await connection.run(`
    UPDATE ${table} t
    SET value = c.new_value
    FROM spike_corrections c
    WHERE t.league = c.league AND t.name = c.name ${variantJoinClause} AND t.day_offset = c.day_offset
  `);
  await connection.run("DROP TABLE spike_corrections");
}

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
  const mainCsvFiles = allCsvFiles.filter((file) => INCLUDED_LEAGUES.includes(path.basename(path.dirname(file))));
  const missingLeagues = INCLUDED_LEAGUES.filter(
    (league) => !mainCsvFiles.some((file) => path.basename(path.dirname(file)) === league)
  );
  if (missingLeagues.length > 0) {
    throw new Error(`No CSV files found for league(s): ${missingLeagues.join(", ")} under ${DATA_DIR}`);
  }

  // Extras live one level deeper, under "<League>/extras/" - see INCLUDED_EXTRA_LEAGUES above.
  const allExtraCsvFiles = await glob("*/extras/*.{currency,items}.csv", { cwd: DATA_DIR, absolute: true });
  const extraCsvFiles = allExtraCsvFiles.filter((file) =>
    INCLUDED_EXTRA_LEAGUES.some((league) => path.basename(file).startsWith(`${league}.`))
  );
  const missingExtraLeagues = INCLUDED_EXTRA_LEAGUES.filter(
    (league) => !extraCsvFiles.some((file) => path.basename(file).startsWith(`${league}.`))
  );
  if (missingExtraLeagues.length > 0) {
    throw new Error(`No CSV files found for extra league(s): ${missingExtraLeagues.join(", ")} under ${DATA_DIR}`);
  }

  const csvFiles = [...mainCsvFiles, ...extraCsvFiles];

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

    // Unlike items, currency trades are frequent/liquid enough that even Low-confidence
    // (few-listing) days are still a real market price, not noise - and Divine Orb's own rate
    // (derived from this table below) needs to be available on as many days as possible for
    // the divine-denominated model to have full coverage, so no confidence filter here at all.
    await connection.run(`
      CREATE TABLE currency_daily AS
      SELECT league, get AS name, date, AVG(value) AS value,
             MAX(CASE WHEN confidence IN ('High', 'Medium') THEN 1 ELSE 0 END) AS is_reliable
      FROM currency_history
      WHERE pay = 'Chaos Orb' AND get != 'Chaos Orb'
      GROUP BY league, get, date
    `);

    // Sanity check specifically for Low-confidence days: found real cases (e.g. Fragment of
    // Terror in late Mirage) where confidence permanently collapses to Low and the price
    // explodes to 100x+ its recent trend for days at a stretch - clearly bad data, not a real
    // market move, since nothing comparable ever happens at High/Medium confidence. This has to
    // be a sequential walk rather than a single SQL pass: a pure-SQL version (ASOF join for the
    // last reliable value + LAG for the previous day's value, both checked against a 5x band)
    // still let a multi-day run of bad values partially through, because LAG reads the RAW
    // (unfiltered) previous day - so a rejected bad value at day N still served as the
    // comparison anchor for day N+1, letting consecutive bad values in a plateau pass against
    // each other. Walking sequentially and tracking "last accepted" ourselves (only ever
    // updated on acceptance) makes rejection correctly cascade through an entire bad run instead.
    const dailyRows = await connection.runAndReadAll(`
      SELECT league, name, date, value, is_reliable
      FROM currency_daily
      ORDER BY league, name, date
    `);
    const dailyRowObjects = dailyRows.getRowObjects();

    // A currency's very first observation in a league has no preceding anchor at all yet (both
    // checks above vacuously pass), so a wild first-day Low-confidence value sails straight
    // through unchecked - e.g. Mirror of Kalandra opened Phrecia 2.0 at 557541c (Low) before
    // immediately settling around 15-45k the very next few days. Worse, that bad value then
    // became lastAcceptedValue, wrongly rejecting the genuinely-fine days right after it too (they
    // looked like implausible drops relative to it). A backward pass giving every row the nearest
    // UPCOMING reliable value closes that hole: an implausible leading value gets caught against
    // what the price actually turns out to be shortly after, without needing the forward walk to
    // have seen a reliable value yet.
    const nextReliableValues: (number | null)[] = new Array(dailyRowObjects.length);
    {
      let groupKey = "";
      let upcomingReliable: number | null = null;
      for (let i = dailyRowObjects.length - 1; i >= 0; i--) {
        const row = dailyRowObjects[i];
        const key = `${row.league as string} ${row.name as string}`;
        if (key !== groupKey) {
          groupKey = key;
          upcomingReliable = null;
        }
        nextReliableValues[i] = upcomingReliable;
        if (Number(row.is_reliable) === 1) upcomingReliable = row.value as number;
      }
    }

    await connection.run(`
      CREATE TABLE currency_daily_filtered (league VARCHAR, name VARCHAR, date DATE, value DOUBLE)
    `);
    const appender = await connection.createAppender("currency_daily_filtered");
    let groupKey = "";
    let lastReliableValue: number | null = null;
    let lastAcceptedValue: number | null = null;
    let filteredCount = 0;
    let totalCount = 0;
    for (let i = 0; i < dailyRowObjects.length; i++) {
      const row = dailyRowObjects[i];
      totalCount++;
      const key = `${row.league as string} ${row.name as string}`;
      if (key !== groupKey) {
        groupKey = key;
        lastReliableValue = null;
        lastAcceptedValue = null;
      }
      const value = row.value as number;
      const isReliable = Number(row.is_reliable) === 1;
      const withinBand = (reference: number | null) =>
        reference === null || (value >= reference / 5 && value <= reference * 5);
      const accepted =
        isReliable ||
        (withinBand(lastReliableValue) && withinBand(lastAcceptedValue) && withinBand(nextReliableValues[i]));

      if (!accepted) {
        filteredCount++;
        continue;
      }
      appender.appendVarchar(row.league as string);
      appender.appendVarchar(row.name as string);
      appender.appendDate(row.date as DuckDBDateValue);
      appender.appendDouble(value);
      appender.endRow();
      lastAcceptedValue = value;
      if (isReliable) lastReliableValue = value;
    }
    appender.closeSync();
    console.log(
      `Currency magnitude sanity check: filtered ${filteredCount} of ${totalCount} Low-confidence day rows`
    );

    await connection.run(`
      CREATE TABLE currency_history_dayed AS
      WITH league_start AS (
        SELECT league, MIN(date) AS start_date FROM currency_daily_filtered GROUP BY league
      )
      SELECT f.league, f.name, f.value, date_diff('day', ls.start_date, f.date) AS day_offset
      FROM currency_daily_filtered f JOIN league_start ls ON f.league = ls.league
    `);
    await connection.run("DROP TABLE currency_daily");
    await connection.run("DROP TABLE currency_daily_filtered");
    await correctSpikesInTable(connection, "currency_history_dayed", false);
    await connection.run(`
      CREATE TABLE item_history_dayed_raw AS
      WITH combined AS (
        -- A linked item prices completely differently from an unlinked one (a 6-link is a
        -- different item to trade, not just a variant of the same one) - fold the links bucket
        -- ("1-4 links"/"5 links"/"6 links") into the variant discriminator so it gets grouped and
        -- matched separately everywhere downstream, and displays as "Name (6 links)" the same way
        -- an existing gem/quality variant already does.
        SELECT
          league, name, date, type, base_type, value,
          CASE
            WHEN links IS NOT NULL AND variant IS NOT NULL THEN variant || ', ' || links
            WHEN links IS NOT NULL THEN links
            ELSE variant
          END AS variant
        FROM item_history
        WHERE confidence IN ('High', 'Medium')
      ),
      daily AS (
        SELECT league, name, variant, date, AVG(value) AS value, ANY_VALUE(type) AS type,
               ANY_VALUE(base_type) AS base_type
        FROM combined
        GROUP BY league, name, variant, date
      ),
      league_start AS (
        SELECT league, MIN(date) AS start_date FROM daily GROUP BY league
      )
      -- poe.ninja files "Vaal Aspect" base-type jewels (e.g. Cooperation) under UniqueJewel, but
      -- they're structurally priced, evergreen items closer in spirit to Fragment than to a
      -- build/meta-driven passive-tree jewel - corrected here once so every downstream consumer
      -- (category filter, badges, lib/category-reliability.ts's tiering) sees the fixed bucket
      -- without needing to know this base type exists. Mirrored for live data in
      -- lib/poe-ninja.ts's correctedItemType() - base_type itself isn't needed past this point, so
      -- it isn't carried into the final table.
      SELECT d.league, d.name, d.variant, d.value,
             CASE WHEN d.type = 'UniqueJewel' AND d.base_type = 'Vaal Aspect' THEN 'Fragment' ELSE d.type END AS type,
             date_diff('day', ls.start_date, d.date) AS day_offset
      FROM daily d JOIN league_start ls ON d.league = ls.league
    `);

    // Magnitude sanity check: unlike currency, every surviving row here already passed a
    // confidence filter (Low was dropped above) - but confirmed empirically that poe.ninja's
    // confidence label alone doesn't guarantee a sane price for a rare/expensive item. Real case:
    // House of Mirrors (Mirage) went 14915.75c -> 17c -> 14.5c -> 28.5c across four straight days,
    // every one of them tagged "High" - a >99% "crash" that's obviously bad data, not a real
    // market move, and it directly corrupted this item's growth-ratio prediction (a 5-day window
    // landed right on the glitch and predicted a 95% loss).
    //
    // Items don't have a separate always-trusted confidence tier left to anchor against the way
    // currency's Low-vs-High/Medium split does (see the currency check above), so this compares
    // each day against a LOCAL windowed median instead - a GLOBAL per-item median would be wrong,
    // since items can legitimately shift to a whole new price tier for the rest of a league (a
    // build gets discovered, demand permanently jumps) and a global median would wrongly flag the
    // new, real price level as the outlier. A local window still tracks that kind of genuine drift
    // (verified: a real sustained step-change is preserved even right at the transition boundary,
    // since the median naturally follows whichever side has the local majority) while catching a
    // short bad run, as long as the bad run is a minority within its own window.
    //
    // The window is defined by ROW COUNT (nearest 25 surviving days each side), not a calendar-day
    // RANGE - tried RANGE first and found it wrongly rejected House of Mirrors' entire legitimate
    // pre-glitch climb: rare items already have gaps from Low-confidence days excluded upstream, so
    // a fixed calendar window can end up containing MORE glitch days than good ones, dragging the
    // median itself into the bad range. A row-count window guarantees enough real neighboring data
    // points regardless of calendar gaps. Also had to widen past an initial +/-15 rows: House of
    // Mirrors' actual bad run turned out to span 16 straight days (not the few days assumed at
    // first), long enough that even a 31-point row-count window was still majority-bad near its
    // center - verified against the real sequence that +/-25 rows correctly keeps both the
    // legitimate pre-glitch climb and the legitimate (much higher) post-glitch price, rejecting only
    // the bad run itself.
    //
    // Pure SQL (a windowed MEDIAN), unlike currency's JS sequential walk - items don't need the
    // "reliable anchor" bootstrapping that walk exists for, since there's no reliable/unreliable
    // split left to bootstrap from here.
    await connection.run(`
      CREATE TABLE item_history_dayed AS
      WITH with_reference AS (
        SELECT *,
               MEDIAN(value) OVER (
                 PARTITION BY league, name, variant ORDER BY day_offset
                 ROWS BETWEEN 25 PRECEDING AND 25 FOLLOWING
               ) AS local_median,
               COUNT(*) OVER (
                 PARTITION BY league, name, variant ORDER BY day_offset
                 ROWS BETWEEN 25 PRECEDING AND 25 FOLLOWING
               ) AS window_count
        FROM item_history_dayed_raw
      )
      SELECT league, name, variant, value, type, day_offset
      FROM with_reference
      -- Too few nearby days to form a trustworthy local median (common for genuinely rare items) -
      -- nothing better to compare against, so accept as-is rather than reject on no evidence.
      WHERE window_count < 5
         OR value BETWEEN local_median / 5 AND local_median * 5
    `);
    const itemFilterCounts = await connection.runAndReadAll(`
      SELECT
        (SELECT COUNT(*) FROM item_history_dayed_raw) AS before_count,
        (SELECT COUNT(*) FROM item_history_dayed) AS after_count
    `);
    const { before_count: itemBefore, after_count: itemAfter } = itemFilterCounts.getRowObjects()[0];
    console.log(
      `Item magnitude sanity check: filtered ${Number(itemBefore) - Number(itemAfter)} of ${itemBefore} day rows`
    );
    await connection.run("DROP TABLE item_history_dayed_raw");
    await correctSpikesInTable(connection, "item_history_dayed", true);

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
