/**
 * Rate-limited client for the trade site's search and fetch endpoints - used only by the sold
 * listing tracker (scripts/track-sold-listings.ts), never by the running app.
 *
 * GGG limits these per IP and locks an IP out for a while if it goes over (the third number of each
 * rule). Every response reports the rules (`X-Rate-Limit-Ip: max:window:penalty,...`) and how much of
 * each window is used (`X-Rate-Limit-Ip-State: used:window:activePenalty,...`). This client:
 *  - queues: before each request it waits until every window of that endpoint has room;
 *  - keeps a margin: it uses only SAFETY_FRACTION of each window's max;
 *  - learns: rules and usage are replaced from every response's headers (the state header also
 *    counts requests from anything else on the same IP);
 *  - backs off: on a 429 or an active penalty it waits it out (Retry-After / the penalty).
 * The trade API isn't in GGG's developer docs; see TODO.md's "Sold tracker: Terms of Use" for the risk.
 */
const TRADE_API = "https://www.pathofexile.com/api/trade";
const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
const SAFETY_FRACTION = 0.7;
/** Waits before retrying a 502/503/504, then it's thrown (a run died on one lone 503, 2026-09-29). */
const SERVER_ERROR_RETRIES_MS = [30_000, 60_000, 120_000];

interface Rule {
  max: number;
  windowSeconds: number;
}

// Measured 2026-09-27; replaced from the headers after the first response.
const DEFAULT_RULES: Record<Endpoint, Rule[]> = {
  search: [
    { max: 5, windowSeconds: 10 },
    { max: 15, windowSeconds: 60 },
    { max: 30, windowSeconds: 300 },
    { max: 600, windowSeconds: 21600 },
  ],
  fetch: [
    { max: 12, windowSeconds: 4 },
    { max: 16, windowSeconds: 12 },
    { max: 50, windowSeconds: 300 },
    { max: 1000, windowSeconds: 21600 },
  ],
};

type Endpoint = "search" | "fetch";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRules(header: string | null): Array<{ a: number; window: number; c: number }> | undefined {
  if (!header) return undefined;
  const parts = header.split(",").map((p) => p.split(":").map(Number));
  if (parts.some((p) => p.length !== 3 || p.some((n) => !Number.isFinite(n)))) return undefined;
  return parts.map(([a, window, c]) => ({ a, window, c }));
}

interface Window {
  rule: Rule;
  /** Request times (ms) counted against this window. Kept per window, because usage learned from
   *  the headers differs per window (a 6-hour window has seen far more than a 10-second one). */
  sent: number[];
}

class EndpointLimiter {
  private windows: Window[];
  private blockedUntil = 0;
  private lastSent = 0;
  private queue: Promise<void> = Promise.resolve();

  /** `paceMs`: at least this long between requests, on top of the rate limit (0 = full speed). */
  constructor(
    rules: Rule[],
    private readonly paceMs = 0
  ) {
    this.windows = rules.map((rule) => ({ rule, sent: [] }));
  }

  private static allowed(rule: Rule): number {
    return Math.max(1, Math.floor(rule.max * SAFETY_FRACTION));
  }

  /** Resolves when a request may go out, and books it. Callers are served in order. */
  acquire(): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
        const now = Date.now();
        if (now < this.blockedUntil) {
          await sleep(this.blockedUntil - now);
          continue;
        }
        let waitMs = Math.max(0, this.lastSent + this.paceMs - now);
        for (const w of this.windows) {
          const windowMs = w.rule.windowSeconds * 1000;
          w.sent = w.sent.filter((t) => now - t < windowMs);
          const allowed = EndpointLimiter.allowed(w.rule);
          if (w.sent.length >= allowed) {
            // The request that has to age out before there's room again.
            const oldest = w.sent[w.sent.length - allowed];
            waitMs = Math.max(waitMs, oldest + windowMs - now + 50);
          }
        }
        if (waitMs === 0) break;
        await sleep(waitMs);
      }
      const now = Date.now();
      this.lastSent = now;
      for (const w of this.windows) w.sent.push(now);
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** Syncs rules and usage from a response. */
  update(res: Response) {
    const rules = parseRules(res.headers.get("x-rate-limit-ip"));
    if (rules) {
      // Keep each window's record when the same window is still in the rules.
      this.windows = rules.map(({ a: max, window }) => ({
        rule: { max, windowSeconds: window },
        sent: this.windows.find((w) => w.rule.windowSeconds === window)?.sent ?? [],
      }));
    }
    const state = parseRules(res.headers.get("x-rate-limit-ip-state"));
    if (state) {
      const now = Date.now();
      for (const { a: used, window, c: penalty } of state) {
        if (penalty > 0) this.blockedUntil = Math.max(this.blockedUntil, now + penalty * 1000);
        // Other requests from this IP (another process, a browser) count too: pad our own record.
        const w = this.windows.find((x) => x.rule.windowSeconds === window);
        if (!w) continue;
        const ours = w.sent.filter((t) => now - t < window * 1000).length;
        for (let i = ours; i < used; i++) w.sent.push(now);
      }
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    if (res.status === 429) this.blockedUntil = Math.max(this.blockedUntil, Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000);
  }
}

export interface TradeListing {
  id: string;
  /** Set on a listing that's no longer on the market (sold or pulled): the fetch still returns its
   *  last listing, with `gone: true` and `item.verified: false`. (Checked 2026-09-29.) */
  gone?: boolean;
  listing: {
    indexed: string;
    price?: { type?: string; amount: number; currency: string };
    fee?: number;
  };
  item: TradeItem;
}

/**
 * A mod as the fetch returns it: its text, plus each stat's roll range in `mods[].magnitudes` (a
 * Watcher's Eye "60% increased Lightning Damage while affected by Wrath" comes with min 40, max 60).
 * Magic/rare mods also carry `name` ("of the Furnace"), `tier` ("P7" = prefix tier 7, "S2" = suffix
 * tier 2; 1 is best) and `level`; unique mods have no tier. A plain string in older responses.
 * (Checked 2026-09-28.)
 */
export type TradeMod =
  | string
  | {
      description?: string;
      /** "explicit", "implicit", ... - and "fractured"/"crafted" for those mods, which the fetch lists
       *  among `explicitMods` (checked 2026-09-28). */
      domain?: string;
      mods?: Array<{ name?: string; tier?: string; level?: number; magnitudes?: Array<{ min?: string; max?: string }> }>;
    };

/** "Limited to: 1", "Level: 70", ... - `values` pairs are [text, display type]. */
export interface TradeProperty {
  name: string;
  values?: Array<[string, number]>;
  displayMode?: number;
}

export interface TradeItem {
  id: string;
  name?: string;
  typeLine?: string;
  baseType?: string;
  rarity?: string;
  frameType?: number;
  ilvl?: number;
  icon?: string;
  identified?: boolean;
  corrupted?: boolean;
  mirrored?: boolean;
  fractured?: boolean;
  synthesised?: boolean;
  duplicated?: boolean;
  split?: boolean;
  mutated?: boolean;
  isRelic?: boolean;
  influences?: Record<string, boolean>;
  sockets?: Array<{ group: number; sColour?: string }>;
  properties?: TradeProperty[];
  requirements?: TradeProperty[];
  enchantMods?: TradeMod[];
  implicitMods?: TradeMod[];
  fracturedMods?: TradeMod[];
  explicitMods?: TradeMod[];
  craftedMods?: TradeMod[];
  crucibleMods?: TradeMod[];
  scourgeMods?: TradeMod[];
  flavourText?: string[];
  /** `text`: the in-game item text (what Ctrl+C copies), base64. */
  extended?: { text?: string };
}

export class TradeApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export class TradeApiClient {
  private limiters: Record<Endpoint, EndpointLimiter>;

  /** `pace`: minimum milliseconds between requests per endpoint, to spread a long job's requests
   *  out instead of spending the limit in bursts. Default: full speed within the limits. */
  constructor(pace: Partial<Record<Endpoint, number>> = {}) {
    this.limiters = {
      search: new EndpointLimiter(DEFAULT_RULES.search, pace.search),
      fetch: new EndpointLimiter(DEFAULT_RULES.fetch, pace.fetch),
    };
  }

  private async request(endpoint: Endpoint, url: string, init?: RequestInit): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await this.limiters[endpoint].acquire();
      const res = await fetch(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/json" },
      });
      this.limiters[endpoint].update(res);
      if (res.status === 429 && attempt < 3) continue; // update() has already set the wait
      // The site's own brief outages (a 503 maintenance page, 502/504 from its edge): wait, retry.
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < SERVER_ERROR_RETRIES_MS.length) {
        await new Promise((r) => setTimeout(r, SERVER_ERROR_RETRIES_MS[attempt]));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        // A 403 with an HTML body is the site's bot protection, not the API.
        const hint = res.status === 403 && body.trimStart().startsWith("<") ? " (blocked before reaching the API - bot protection?)" : "";
        throw new TradeApiError(`${endpoint} ${res.status}${hint}: ${body.slice(0, 200)}`, res.status);
      }
      return res.json();
    }
  }

  /** Up to 100 listing ids, in the order `sort` asks for, plus the number matching. */
  async search(league: string, query: unknown, sort: Record<string, string>): Promise<{ ids: string[]; total: number }> {
    const json = (await this.request("search", `${TRADE_API}/search/${encodeURIComponent(league)}`, {
      method: "POST",
      body: JSON.stringify({ query, sort }),
    })) as { result?: string[]; total?: number };
    return { ids: json.result ?? [], total: json.total ?? 0 };
  }

  /**
   * Listings by id, up to 10 per request; `null` for an id that's no longer listed. A sold or pulled
   * listing doesn't come back empty - the fetch returns its last listing marked `gone: true` - so
   * those are turned into `null` here. (An id that never existed is `null` from the API itself.)
   */
  async fetchListings(ids: string[]): Promise<Array<TradeListing | null>> {
    const out: Array<TradeListing | null> = [];
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      const json = (await this.request("fetch", `${TRADE_API}/fetch/${batch.join(",")}`)) as { result?: Array<TradeListing | null> };
      batch.forEach((_, k) => {
        const listing = json.result?.[k] ?? null;
        out.push(listing && !listing.gone ? listing : null);
      });
    }
    return out;
  }
}
