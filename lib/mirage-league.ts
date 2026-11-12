// Plain constants shared by the server-only simulator (lib/mirage-simulator.ts) and the client
// panel that renders it (the Past league simulator) - kept in their own file, with no "server-only"
// or DuckDB imports, so the client component can import the actual values rather than just types.

/** A finished league the Past league simulator can replay. Each needs a model trained without it in
 *  lib/models/holdout/<name>.json (see lib/simulator-models.ts) and its history in db/history.duckdb. */
export interface SimulatedLeague {
  name: string;
  /** The league's last day in db/history.duckdb (day 0 = launch). */
  lastDay: number;
}

/** Newest first - the first is the page's default. */
export const SIMULATED_LEAGUES: readonly SimulatedLeague[] = [
  { name: "Allflame", lastDay: 110 },
  { name: "Mirage", lastDay: 136 },
];

/** The league scripts replay by default (scripts/backtest-predictor.ts, the retrain workflow's backtest). */
export const SIMULATED_LEAGUE = "Mirage";

/** Days kept clear at a league's end: the simulator matches the "actual" price within +-10 days, so a
 *  target day right at the end would be scored against a price from days before it. */
export const SIMULATOR_END_MARGIN_DAYS = 3;

export function simulatedLeague(name: string | null | undefined): SimulatedLeague | undefined {
  return SIMULATED_LEAGUES.find((l) => l.name === name);
}
