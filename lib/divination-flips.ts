import "server-only";
import { DIVINATION_CARDS, type DivinationRewardKind } from "./divination-cards";
import { getAllCurrentCurrencyPrices, getAllCurrentItemPrices, itemPriceKey } from "./poe-ninja";
import { getActiveTypes } from "./price-snapshot";
import { getExchangeQuotes, isFaustusTradeable, type ItemMarket } from "./faustus";
import type { MarketStockRange } from "./exchange-route";
import { liquidityTier, type LiquidityTier } from "./liquidity";

/**
 * Finds divination cards where buying a full stack and turning it in costs less than the reward is
 * worth right now - e.g. "The Nurse" at 10c x8 stack = 80c, turned in for one "The Doctor" worth
 * 100c = 20c profit. See lib/divination-cards.ts for how the card->reward data is sourced and
 * scoped to only deterministic (single, currently-priced) rewards.
 *
 * Confidence here is deliberately NOT lib/confidence.ts's score (that measures how consistently an
 * item's price has grown across past leagues - meaningless for a card's fixed, one-shot reward).
 * A card flip has two legs that both need to be real, fillable trades - buying the card, selling
 * the reward - so confidence is the WEAKER of the two legs' liquidity, using the same
 * lib/liquidity.ts tiering the Currency Exchange Flip page already uses for exactly this "is this
 * spread real or just rounding noise on a barely-traded item" question.
 *
 * Both buy costs come from the card's last closed hour on GGG's exchange, the same "buy at low, sell
 * at high" reading the Currency Exchange Flip page uses: a buy order pays the bottom of the hour's
 * range, an instant buy (taking someone else's sell order) the top. Same source and hour, so an
 * instant buy can never read cheaper than a buy order. poe.ninja's card price is only the buy-order
 * cost for a card with no exchange market (no instant cost then). It used to be the buy-order cost
 * for every card, and being a different source at a different time it sat above the hour's top for
 * 13 of 33 exchange-traded cards (2026-09-27), making the instant buy look cheaper.
 *
 * Divine mode buys the cards with divines, not a conversion: each card on its own Divine market. A
 * card with no Divine market that hour has no Divine figures at all, and the table hides it. The
 * reward is still valued at its chaos price (poe.ninja's), converted to divines at poe.ninja's Divine
 * rate - the owner's call, since that's what it sells for.
 */
export interface DivinationFlip {
  name: string;
  stackSize: number;
  /** Per-card buy-order price: the bottom of the card's hour range on the exchange, or poe.ninja's
   *  price when it has no exchange market. */
  cardChaosValue: number;
  /** The same on the card's Divine market - undefined when it had no Divine market this hour,
   *  which leaves every Divine figure below undefined and hides the row in Divine mode. */
  cardDivineValue?: number;
  /** The card's hour-range low/high on GGG's Currency Exchange: chaos from its Chaos market (or its
   *  Divine market converted, for a card only traded for divines), divine from its Divine market.
   *  Undefined when there's no such market right now (see faustusTradeable). */
  buyMinChaosValue?: number;
  buyMaxChaosValue?: number;
  buyMinDivineValue?: number;
  buyMaxDivineValue?: number;
  /** Stock behind the Min/Max range: the chaos-mode market's, and the Divine market's. */
  buyStock?: MarketStockRange;
  buyStockDivine?: MarketStockRange;
  /** Whether GGG's Currency Exchange covers this exact card at all - drives the on-demand
   *  "Exchange Price" button (components/faustus-price-button.tsx), same as the main dashboard. */
  faustusTradeable: boolean;
  rewardName: string;
  rewardKind: DivinationRewardKind;
  rewardQuantity: number;
  /** rewardQuantity units of rewardName, at today's live price. */
  rewardChaosValue: number;
  rewardDivineValue?: number;
  /** cardChaosValue * stackSize - the full cost to buy one turn-in's worth of cards. */
  stackCostChaosValue: number;
  stackCostDivineValue?: number;
  /** rewardChaosValue - stackCostChaosValue. */
  profitChaosValue: number;
  profitDivineValue?: number;
  /** buyMax*Value * stackSize: the stack bought instantly, off other players' sell orders. */
  instantCostChaosValue?: number;
  instantCostDivineValue?: number;
  /** rewardChaosValue - instantCostChaosValue (and the same in divines). */
  instantProfitChaosValue?: number;
  instantProfitDivineValue?: number;
  /** rewardChaosValue / stackCostChaosValue - 1. */
  profitPercent: number;
  confidence: LiquidityTier;
  /** The same for Divine mode, with the card leg measured on its Divine market. Undefined with
   *  cardDivineValue. */
  confidenceDivine?: LiquidityTier;
}

// Seller-count tiering for a unique-item reward leg, which poe.ninja exposes no volume figure for
// (ItemPrice.sellerCount only) - mirrors the shape of the thin-market guard already established in
// lib/flip-suggestions.ts (MIN_ITEM_SELLER_COUNT_FOR_EXTREME_RATIO), not a new invented scheme.
// Thresholds are deliberately much lower than lib/liquidity.ts's chaos-volume ones since seller
// count and chaos volume aren't the same unit - this only needs to separate "plenty of listings to
// actually buy from" from "one or two sellers setting the whole price."
const UNIQUE_SELLER_COUNT_HIGH_MIN = 20;
const UNIQUE_SELLER_COUNT_MEDIUM_MIN = 5;

function sellerCountTier(sellerCount: number | undefined): LiquidityTier {
  if (sellerCount === undefined) return "low";
  if (sellerCount >= UNIQUE_SELLER_COUNT_HIGH_MIN) return "high";
  if (sellerCount >= UNIQUE_SELLER_COUNT_MEDIUM_MIN) return "medium";
  return "low";
}

// Weaker-of-two-legs: "high" confidence needs BOTH legs to be liquid, "low" if EITHER leg is thin.
const TIER_RANK: Record<LiquidityTier, number> = { low: 0, medium: 1, high: 2 };
function weakerTier(a: LiquidityTier, b: LiquidityTier): LiquidityTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

// Short-lived cache + in-flight-promise coalescing, same pattern and reasoning as
// lib/flip-suggestions.ts's own getFlipSuggestions cache: this is called both by
// app/api/divination-flips/route.ts (the Divination Card Flips table) AND by
// components/item-detail-panel.tsx (checking whether the current item is a priceable card), so a
// page that fires both around the same time - or several people/tabs hitting either at once -
// would otherwise each independently redo the full currency/item-price fetch and per-card matching
// pass. TTL matches getFlipSuggestions's - live prices move, but not fast enough to need a fresher
// cache than a minute for this kind of point-in-time page load.
const CACHE_TTL_MS = 60 * 1000;
interface CacheEntry {
  promise: Promise<DivinationFlip[]>;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * Finds every divination card currently priced (both the card itself and its reward), ranked by
 * profit percent. Skips a card entirely - rather than fabricating a number - whenever poe.ninja
 * isn't pricing the card itself right now, or the reward name doesn't match anything in today's
 * live price data (this is the second half of lib/divination-cards.ts's scoping rule: a single-tag
 * placeholder like "Axe" or "League-Specific Item" simply never matches a real item name here).
 */
export async function getDivinationFlips(league: string): Promise<DivinationFlip[]> {
  const cached = cache.get(league);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = computeDivinationFlips(league);
  cache.set(league, { promise, expiresAt: Date.now() + CACHE_TTL_MS });
  promise.catch(() => cache.delete(league));
  return promise;
}

async function computeDivinationFlips(league: string): Promise<DivinationFlip[]> {
  // Prices stay live here (a profit calculation worth acting on), but the daily snapshot's list of
  // non-empty category buckets lets the live fetch skip the ones with no listings at all - same
  // prices, ~a quarter fewer requests. See lib/price-snapshot.ts's getActiveTypes.
  const activeTypes = await getActiveTypes(league);
  const [currencyPrices, itemPrices, quotes] = await Promise.all([
    getAllCurrentCurrencyPrices(league, activeTypes.currency),
    getAllCurrentItemPrices(league, activeTypes.item),
    getExchangeQuotes(league),
  ]);
  // poe.ninja's Divine rate, for the reward's value in Divine mode (see the module doc).
  const ninjaDivineRate = currencyPrices.get("Divine Orb")?.chaosValue;
  const exchangeTier = (m: ItemMarket | undefined): LiquidityTier => (m ? liquidityTier(m.volumeChaos) : "low");
  const toChaos = (m: ItemMarket, v: number) => (m.currency === "chaos" ? v : v * (quotes.divineChaosRate ?? 0));
  const stockOf = (m: ItemMarket | undefined): MarketStockRange | undefined =>
    m ? { cards: m.stockRange.item, currency: m.stockRange.currency, currencyIn: m.currency } : undefined;

  const flips: DivinationFlip[] = [];
  for (const def of DIVINATION_CARDS) {
    const cardPrice = currencyPrices.get(def.name);
    if (!cardPrice || !(cardPrice.chaosValue > 0)) continue; // poe.ninja isn't pricing this card right now

    const rewardMarkets = def.rewardKind === "unique" ? undefined : quotes.markets.get(def.rewardName);
    let rewardChaosPerUnit: number | undefined;
    let rewardConfidence: LiquidityTier;
    if (def.rewardKind === "unique") {
      const item = itemPrices.get(itemPriceKey(def.rewardName));
      rewardChaosPerUnit = item?.chaosValue;
      rewardConfidence = sellerCountTier(item?.sellerCount);
    } else if (def.rewardName === "Chaos Orb") {
      // The pivot currency: worth exactly its count, and the most liquid thing there is.
      rewardChaosPerUnit = 1;
      rewardConfidence = "high";
    } else {
      // "currency" and "card" rewards both live in the same currency price map - a divination
      // card's own price (DivinationCard type) is fetched from the same getAllCurrentCurrencyPrices
      // call this app already uses for currency, so a card-to-card reward needs no separate lookup.
      rewardChaosPerUnit = currencyPrices.get(def.rewardName)?.chaosValue;
      rewardConfidence = exchangeTier(rewardMarkets?.chaos ?? rewardMarkets?.divine);
    }
    if (rewardChaosPerUnit === undefined || !(rewardChaosPerUnit > 0)) continue; // reward not (yet) priceable

    // Chaos mode: the card's Chaos market (or, for a card only traded for divines, that market).
    const cardMarkets = quotes.markets.get(def.name);
    const rangeMarket = cardMarkets?.chaos ?? cardMarkets?.divine;
    const cardConfidence = exchangeTier(rangeMarket);

    // Buy order: the bottom of the card's hour range; poe.ninja's price only with no exchange market.
    const buyMinChaosValue = rangeMarket ? toChaos(rangeMarket, rangeMarket.low) : undefined;
    const cardChaosValue = buyMinChaosValue ?? cardPrice.chaosValue;

    const rewardChaosValue = rewardChaosPerUnit * def.rewardQuantity;
    const stackCostChaosValue = cardChaosValue * def.stackSize;
    const profitChaosValue = rewardChaosValue - stackCostChaosValue;

    // Divine mode: the cards bought on their own Divine market, or not at all; the reward at its
    // chaos value converted.
    const cardDivineMarket = cardMarkets?.divine;
    const cardDivineValue = cardDivineMarket?.low;
    const stackCostDivineValue = cardDivineValue !== undefined ? cardDivineValue * def.stackSize : undefined;
    const rewardDivineValue = ninjaDivineRate ? rewardChaosValue / ninjaDivineRate : undefined;
    const divinePriced = stackCostDivineValue !== undefined && rewardDivineValue !== undefined;

    // Instant buy: the top of the card's hour trade range, per stack.
    const buyMaxChaosValue = rangeMarket ? toChaos(rangeMarket, rangeMarket.high) : undefined;
    const instantCostChaosValue = buyMaxChaosValue !== undefined ? buyMaxChaosValue * def.stackSize : undefined;
    const instantCostDivineValue = divinePriced && cardDivineMarket ? cardDivineMarket.high * def.stackSize : undefined;

    flips.push({
      name: def.name,
      stackSize: def.stackSize,
      cardChaosValue,
      cardDivineValue,
      buyMinChaosValue,
      buyMaxChaosValue,
      buyMinDivineValue: cardDivineMarket?.low,
      buyMaxDivineValue: cardDivineMarket?.high,
      buyStock: stockOf(rangeMarket),
      buyStockDivine: stockOf(cardDivineMarket),
      faustusTradeable: isFaustusTradeable(def.name),
      rewardName: def.rewardName,
      rewardKind: def.rewardKind,
      rewardQuantity: def.rewardQuantity,
      rewardChaosValue,
      rewardDivineValue,
      stackCostChaosValue,
      stackCostDivineValue: divinePriced ? stackCostDivineValue : undefined,
      profitChaosValue,
      profitDivineValue: divinePriced ? rewardDivineValue - stackCostDivineValue : undefined,
      instantCostChaosValue,
      instantCostDivineValue,
      instantProfitChaosValue: instantCostChaosValue !== undefined ? rewardChaosValue - instantCostChaosValue : undefined,
      instantProfitDivineValue:
        instantCostDivineValue !== undefined && rewardDivineValue !== undefined ? rewardDivineValue - instantCostDivineValue : undefined,
      profitPercent: (rewardChaosValue / stackCostChaosValue - 1) * 100,
      confidence: weakerTier(cardConfidence, rewardConfidence),
      confidenceDivine: divinePriced ? weakerTier(exchangeTier(cardDivineMarket), rewardConfidence) : undefined,
    });
  }

  return flips.sort((a, b) => b.profitPercent - a.profitPercent);
}
