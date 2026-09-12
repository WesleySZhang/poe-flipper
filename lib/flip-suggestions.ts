import "server-only";
import { getDb } from "./db";
import { getAllCurrentCurrencyPrices, getAllCurrentItemPrices, itemPriceKey } from "./poe-ninja";

export interface FlipSuggestion {
  name: string;
  category: "currency" | "item";
  currentChaosValue: number;
  avgGrowthRatio: number;
  leagueCount: number;
  rationale: string;
}

interface HistoricalTrend {
  name: string;
  variant?: string;
  avgGrowthRatio: number;
  leagueCount: number;
}

// Requires enough same-league data points so a single early/late outlier can't dominate the ratio.
const MIN_DATA_POINTS_PER_LEAGUE = 5;
const MIN_LEAGUES_WITH_DATA = 2;

async function getCurrencyTrends(): Promise<HistoricalTrend[]> {
  const db = await getDb();
  const reader = await db.runAndReadAll(`
    WITH bounds AS (
      SELECT league, get AS name,
             arg_min(value, date) AS first_value,
             arg_max(value, date) AS last_value,
             COUNT(*) AS data_points
      FROM currency_history
      WHERE pay = 'Chaos Orb' AND get != 'Chaos Orb' AND confidence != 'Low'
      GROUP BY league, get
      HAVING COUNT(*) >= ${MIN_DATA_POINTS_PER_LEAGUE}
    )
    SELECT name,
           AVG(last_value / NULLIF(first_value, 0)) AS avg_growth_ratio,
           COUNT(*) AS league_count
    FROM bounds
    WHERE first_value >= 0.1
    GROUP BY name
    HAVING COUNT(*) >= ${MIN_LEAGUES_WITH_DATA}
  `);
  return reader.getRowObjects().map((row) => ({
    name: String(row.name),
    avgGrowthRatio: Number(row.avg_growth_ratio),
    leagueCount: Number(row.league_count),
  }));
}

async function getItemTrends(): Promise<HistoricalTrend[]> {
  const db = await getDb();
  const reader = await db.runAndReadAll(`
    WITH daily AS (
      -- one row per (league, name, variant, date): gems/uniques differ hugely in price by variant
      SELECT league, name, variant, date, AVG(value) AS value
      FROM item_history
      WHERE confidence != 'Low'
      GROUP BY league, name, variant, date
    ),
    bounds AS (
      SELECT league, name, variant,
             arg_min(value, date) AS first_value,
             arg_max(value, date) AS last_value,
             COUNT(*) AS data_points
      FROM daily
      GROUP BY league, name, variant
      HAVING COUNT(*) >= ${MIN_DATA_POINTS_PER_LEAGUE}
    )
    SELECT name, variant,
           AVG(last_value / NULLIF(first_value, 0)) AS avg_growth_ratio,
           COUNT(*) AS league_count
    FROM bounds
    WHERE first_value >= 0.1
    GROUP BY name, variant
    HAVING COUNT(*) >= ${MIN_LEAGUES_WITH_DATA}
  `);
  return reader.getRowObjects().map((row) => ({
    name: String(row.name),
    variant: row.variant ? String(row.variant) : undefined,
    avgGrowthRatio: Number(row.avg_growth_ratio),
    leagueCount: Number(row.league_count),
  }));
}

function buildSuggestion(
  trend: HistoricalTrend,
  category: "currency" | "item",
  currentChaosValue: number
): FlipSuggestion {
  const pctChange = Math.round((trend.avgGrowthRatio - 1) * 100);
  const direction = pctChange >= 0 ? "risen" : "fallen";
  const displayName = trend.variant ? `${trend.name} (${trend.variant})` : trend.name;
  return {
    name: displayName,
    category,
    currentChaosValue,
    avgGrowthRatio: trend.avgGrowthRatio,
    leagueCount: trend.leagueCount,
    rationale: `Historically has ${direction} ${Math.abs(pctChange)}% from league start to league end, averaged over ${trend.leagueCount} past leagues.`,
  };
}

/** Ranks items/currency by historical start-of-league to end-of-league growth, priced at today's live value. */
export async function getFlipSuggestions(league: string, limit = 15): Promise<FlipSuggestion[]> {
  const [currencyTrends, itemTrends, currencyPrices, itemPrices] = await Promise.all([
    getCurrencyTrends(),
    getItemTrends(),
    getAllCurrentCurrencyPrices(league),
    getAllCurrentItemPrices(league),
  ]);

  const suggestions: FlipSuggestion[] = [];

  for (const trend of currencyTrends) {
    const currentChaosValue = currencyPrices.get(trend.name);
    if (currentChaosValue === undefined || currentChaosValue <= 0) continue;
    suggestions.push(buildSuggestion(trend, "currency", currentChaosValue));
  }

  for (const trend of itemTrends) {
    const currentChaosValue = itemPrices.get(itemPriceKey(trend.name, trend.variant));
    if (currentChaosValue === undefined || currentChaosValue <= 0) continue;
    suggestions.push(buildSuggestion(trend, "item", currentChaosValue));
  }

  return suggestions.sort((a, b) => b.avgGrowthRatio - a.avgGrowthRatio).slice(0, limit);
}
