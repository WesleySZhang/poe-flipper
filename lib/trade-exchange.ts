import "server-only";
import { getAllCurrentCurrencyPrices } from "./poe-ninja";
import { getActiveTypes } from "./price-snapshot";
import { tradeRateLimiters } from "./trade-rate-limit";

/**
 * Live listings for one item on the official trade site's bulk exchange, grouped by price: each
 * price level with the stock listed at it ("10c - 10 in stock, 12c - 100 in stock"). Backs the
 * Exchange Price button, and only runs when someone presses it - the trade API is rate limited per
 * IP (lib/trade-rate-limit.ts), and this app's server is one IP for every user.
 *
 * Only online sellers. The bulk exchange is thin since the in-game Currency Exchange took over most
 * bulk trading (2026-09-28: 4 online Divine Orb listings, 5 Stacked Deck, 1 The Doctor), so an
 * empty result is common and shown as such.
 */
const TRADE_API = "https://www.pathofexile.com/api/trade/exchange";
const USER_AGENT = "poe-flipper/0.1.0 (personal, non-commercial; unaffiliated with GGG)";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_LEVELS = 8;
const PAY_WITH = ["chaos", "divine"] as const;
type PayCurrency = (typeof PAY_WITH)[number];

export interface ListingLevel {
  /** Price per unit, in the listing's currency. */
  price: number;
  /** Units listed at this price, summed across sellers. */
  stock: number;
  sellers: number;
}

export interface ExchangeListings {
  /** Cheapest first, at most MAX_LEVELS each. */
  chaos: ListingLevel[];
  divine: ListingLevel[];
  /** Listings the search matched in total (it returns up to 100). */
  total: number;
  fetchedAt: string;
}

export type ExchangeListingsResult =
  | { status: "ok"; listings: ExchangeListings }
  | { status: "unknown" }
  | { status: "limited"; retryAfterSeconds: number }
  | { status: "error"; message: string };

interface TradeOffer {
  exchange: { currency: string; amount: number };
  item: { currency: string; amount: number; stock: number };
}

interface TradeExchangeResponse {
  total?: number;
  result?: Record<string, { listing: { offers: TradeOffer[] } }>;
  error?: { code: number; message: string };
}

const cache = new Map<string, { promise: Promise<ExchangeListingsResult>; expiresAt: number }>();

export async function getExchangeListings(name: string, league: string): Promise<ExchangeListingsResult> {
  const key = `${league}:${name}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = fetchListings(name, league);
  cache.set(key, { promise, expiresAt: Date.now() + CACHE_TTL_MS });
  // Only a real answer is worth reusing; a refusal or error should be retryable right away.
  promise.then((r) => r.status !== "ok" && r.status !== "unknown" && cache.delete(key)).catch(() => cache.delete(key));
  return promise;
}

async function fetchListings(name: string, league: string): Promise<ExchangeListingsResult> {
  const activeTypes = await getActiveTypes(league);
  const tradeId = (await getAllCurrentCurrencyPrices(league, activeTypes.currency)).get(name)?.tradeId;
  if (!tradeId) return { status: "unknown" };

  const limiter = tradeRateLimiters.exchange;
  const slot = await limiter.acquire();
  if (!slot.ok) return { status: "limited", retryAfterSeconds: Math.ceil(slot.retryAfterMs / 1000) };

  const body = {
    query: { status: { option: "online" }, have: PAY_WITH.filter((c) => c !== tradeId), want: [tradeId] },
    sort: { have: "asc" },
    engine: "new",
  };
  let res: Response;
  try {
    res = await fetch(`${TRADE_API}/${encodeURIComponent(league)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "Request failed" };
  }
  limiter.update(res.headers, res.status);
  if (res.status === 429) {
    return { status: "limited", retryAfterSeconds: Number(res.headers.get("retry-after")) || 60 };
  }
  const data = (await res.json().catch(() => ({}))) as TradeExchangeResponse;
  if (!res.ok || data.error) return { status: "error", message: data.error?.message ?? `HTTP ${res.status}` };

  const levels: Record<PayCurrency, Map<number, ListingLevel>> = { chaos: new Map(), divine: new Map() };
  for (const { listing } of Object.values(data.result ?? {})) {
    for (const offer of listing.offers) {
      const currency = offer.exchange.currency as PayCurrency;
      if (!PAY_WITH.includes(currency) || offer.item.currency !== tradeId || !(offer.item.amount > 0)) continue;
      const price = offer.exchange.amount / offer.item.amount;
      const level = levels[currency].get(price) ?? { price, stock: 0, sellers: 0 };
      level.stock += offer.item.stock;
      level.sellers += 1;
      levels[currency].set(price, level);
    }
  }
  const cheapest = (m: Map<number, ListingLevel>) => [...m.values()].sort((a, b) => a.price - b.price).slice(0, MAX_LEVELS);
  return {
    status: "ok",
    listings: { chaos: cheapest(levels.chaos), divine: cheapest(levels.divine), total: data.total ?? 0, fetchedAt: new Date().toISOString() },
  };
}
