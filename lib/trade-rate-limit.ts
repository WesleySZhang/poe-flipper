import "server-only";

/**
 * Client-side rate limiting for the official trade site's API, which limits per IP and blocks an IP
 * that goes over (a 60 s to 1 h timeout, by rule). Every response states the limits and how much of
 * each has been used:
 *
 *   X-Rate-Limit-Rules: Ip
 *   X-Rate-Limit-Ip:       5:10:60,15:60:300,30:300:1800,600:21600:3600   (max:window s:timeout s)
 *   X-Rate-Limit-Ip-State: 1:10:0,1:60:0,1:300:0,1:21600:0               (used:window s:active timeout s)
 *
 * (search, 2026-09-28; the bulk exchange's were 5:15:60,10:90:300,30:300:1800). Each endpoint has its
 * own policy, so each gets its own limiter. A limiter starts at a conservative 1 request per 5 s,
 * then adopts the rules from every response, and syncs its count up to the server's: this app runs
 * on shared hosting where other instances (and anything else on the same IP) count too, so the
 * server's number is the truth. A request that would have to wait RETRY_THRESHOLD_MS or more is
 * refused with a retry time rather than queued - the caller is a person pressing a button.
 *
 * State lives in the server process, so separate serverless instances don't share it; the header
 * sync is what keeps them from overrunning the IP's limit together.
 */
export const RETRY_THRESHOLD_MS = 1500;
// Added to every window: the server's window starts when it receives the request, ours when we
// send it, so without a margin we'd think a slot is free a moment before the server does.
const LATENCY_MARGIN_S = 2;
const DEFAULT_RULES: Rule[] = [{ max: 1, windowSeconds: 5 }];

interface Rule {
  max: number;
  windowSeconds: number;
}

export type AcquireResult = { ok: true } | { ok: false; retryAfterMs: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TradeRateLimiter {
  private rules: Rule[] = DEFAULT_RULES;
  /** Send times (ms) of requests still inside the longest window. */
  private sent: number[] = [];
  private blockedUntil = 0;
  // Serializes acquire() so two callers can't both claim the same free slot.
  private queue: Promise<unknown> = Promise.resolve();

  /** How long until one more request fits every rule. */
  private waitMs(now: number): number {
    let wait = Math.max(0, this.blockedUntil - now);
    for (const rule of this.rules) {
      const windowMs = (rule.windowSeconds + LATENCY_MARGIN_S) * 1000;
      const inWindow = this.sent.filter((t) => t > now - windowMs);
      if (inWindow.length >= rule.max) {
        // The request that has to age out before one more fits.
        const blocking = inWindow[inWindow.length - rule.max];
        wait = Math.max(wait, blocking + windowMs - now);
      }
    }
    return wait;
  }

  /** Claims a slot, waiting briefly if needed; refuses when the wait would be RETRY_THRESHOLD_MS+. */
  acquire(): Promise<AcquireResult> {
    const result = this.queue.then(async (): Promise<AcquireResult> => {
      const wait = this.waitMs(Date.now());
      if (wait >= RETRY_THRESHOLD_MS) return { ok: false, retryAfterMs: wait };
      if (wait > 0) await sleep(wait);
      this.sent.push(Date.now());
      this.prune();
      return { ok: true };
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Adopts the rules and usage a response reports, and any timeout it announces. */
  update(headers: Headers, status: number): void {
    const now = Date.now();
    const ruleNames = headers.get("x-rate-limit-rules");
    if (ruleNames) {
      const rules: Rule[] = [];
      for (const ruleName of ruleNames.split(",").map((r) => r.trim().toLowerCase())) {
        const limits = parseTriples(headers.get(`x-rate-limit-${ruleName}`));
        const states = parseTriples(headers.get(`x-rate-limit-${ruleName}-state`));
        limits.forEach(([max, windowSeconds], i) => {
          rules.push({ max, windowSeconds });
          const state = states[i];
          if (!state) return;
          const [used, , activeTimeoutSeconds] = state;
          if (activeTimeoutSeconds > 0) this.blockedUntil = Math.max(this.blockedUntil, now + activeTimeoutSeconds * 1000);
          // Sync up to the server's count for this window (never down - ours may be more recent).
          const windowMs = (windowSeconds + LATENCY_MARGIN_S) * 1000;
          const ours = this.sent.filter((t) => t > now - windowMs).length;
          for (let n = ours; n < used; n++) this.sent.push(now);
        });
      }
      if (rules.length > 0) this.rules = rules;
      this.sent.sort((a, b) => a - b);
    }
    if (status === 429) {
      const retryAfter = Number(headers.get("retry-after"));
      this.blockedUntil = Math.max(this.blockedUntil, now + (retryAfter > 0 ? retryAfter : 60) * 1000);
    }
    this.prune();
  }

  private prune(): void {
    const longest = Math.max(...this.rules.map((r) => r.windowSeconds)) + LATENCY_MARGIN_S;
    const cutoff = Date.now() - longest * 1000;
    this.sent = this.sent.filter((t) => t > cutoff);
  }
}

/** "5:10:60,15:60:300" -> [[5,10,60],[15,60,300]]. */
function parseTriples(header: string | null): number[][] {
  if (!header) return [];
  return header.split(",").map((part) => part.split(":").map(Number));
}

/** One limiter per trade API endpoint - each has its own policy. */
export const tradeRateLimiters = {
  exchange: new TradeRateLimiter(),
};
