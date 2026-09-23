/** Number of whole days between two dates (UTC, ignores time-of-day). */
export function daysBetweenUtc(start: Date, end: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.round((endUtc - startUtc) / msPerDay);
}

// .github/workflows/precompute-predictions.yml's daily job runs at 00:10 UTC and, as measured,
// takes about 2 minutes end to end (checkout, npm ci, the actual compute, publishing to the "data"
// branch) - so it's typically done by ~00:12 UTC. Without any buffer, currentLeagueDay() flips to the
// new day at the exact instant of midnight, while every consumer of "today"
// (lib/precomputed-predictions.ts's day-match check, the current league's real-history CSV row) is
// still waiting on that job - a precomputed-predictions miss that falls back to a slower live model
// run, or a missing "today" row in the price history. Rather than trying to make the job start and
// finish inside an ever-tighter margin, this delays the app's OWN notion of "today" by a fixed buffer
// instead - 20 minutes leaves ~8 minutes of slack past the job's typical ~00:12 UTC finish for GitHub's
// own scheduler occasionally starting the cron a bit late or a slower-than-usual run, while a same-day,
// 20-minutes-later flip is still completely imperceptible to any real visitor. Every caller of
// currentLeagueDay() goes through this automatically (nobody in this codebase ever passes an explicit
// `now` - see its own default parameter below), so this one constant keeps the frontend, every API
// route, and the precompute job itself all in sync for free.
const DAY_ROLLOVER_GRACE_MS = 20 * 60 * 1000;

/** Current day-of-league (0 = launch day), clamped to >= 0 since a future start date makes no sense
 *  here (also covers the grace period pushing `now` earlier than the league's own start, right at
 *  the very start of a league). See DAY_ROLLOVER_GRACE_MS above for why `now` isn't used as-is. */
export function currentLeagueDay(leagueStartDate: string, now: Date = new Date()): number {
  const start = new Date(leagueStartDate);
  const effectiveNow = new Date(now.getTime() - DAY_ROLLOVER_GRACE_MS);
  return Math.max(0, daysBetweenUtc(start, effectiveNow));
}
