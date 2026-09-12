/** Number of whole days between two dates (UTC, ignores time-of-day). */
export function daysBetweenUtc(start: Date, end: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.round((endUtc - startUtc) / msPerDay);
}

/** Current day-of-league (0 = launch day), clamped to >= 0 since a future start date makes no sense here. */
export function currentLeagueDay(leagueStartDate: string, now: Date = new Date()): number {
  const start = new Date(leagueStartDate);
  return Math.max(0, daysBetweenUtc(start, now));
}
