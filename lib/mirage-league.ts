// Plain constants shared by the server-only simulator (lib/mirage-simulator.ts) and the client
// panel that renders it - kept in their own file, with no "server-only" or DuckDB imports, so the
// client component can import the actual values rather than just types.

/** The league every simulation replays - always excluded from training data (see growth-ratios.ts). */
export const SIMULATED_LEAGUE = "Mirage";

// Mirage ran 2026-03-06 -> 2026-07-20 (~136 days) - clamps the day picker so users can't ask "what
// would the model have predicted" for a day that's past when the league actually ended.
export const MIRAGE_LEAGUE_LENGTH_DAYS = 136;
