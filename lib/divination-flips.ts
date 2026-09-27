import "server-only";
import { DIVINATION_CARDS, type DivinationRewardKind } from "./divination-cards";
import { getAllCurrentCurrencyPrices, getAllCurrentItemPrices, itemPriceKey } from "./poe-ninja";
import { getActiveTypes } from "./price-snapshot";
import { getExchangeQuotes, isFaustusTradeable, marketMid, type ItemMarket, type ItemMarkets } from "./faustus";
import { liquidityTier, type LiquidityTier } from "./liquidity";
import { pickRoute, type LegOption, type LegSource } from "./exchange-route";

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
 * Both legs can trade against Chaos or against Divine on GGG's exchange, which don't always agree, so
 * each flip takes the best route (lib/exchange-route.ts): e.g. buy the cards with divines and sell
 * the reward for chaos. Exchange legs use the hour's midpoint (a whole stack won't all fill at the
 * hour's best rate); a leg with no exchange market this hour uses poe.ninja's price.
 */
export interface DivinationFlip {
  name: string;
  stackSize: number;
  /** Where the cards are bought and the reward sold - see lib/exchange-route.ts. */
  buyIn: LegSource;
  sellIn: LegSource;
  /** Per-card price on the buy route (the market's hour midpoint, or poe.ninja's). */
  cardChaosValue: number;
  cardDivineValue?: number;
  /** The buy market's hour-range low/high per card - undefined when the cards are priced at
   *  poe.ninja (no exchange market for this card right now; see faustusTradeable). */
  buyMinChaosValue?: number;
  buyMaxChaosValue?: number;
  buyMinDivineValue?: number;
  buyMaxDivineValue?: number;
  /** Whether GGG's Currency Exchange covers this exact card at all - drives the on-demand
   *  "Exchange Price" button (components/faustus-price-button.tsx), same as the main dashboard. */
  faustusTradeable: boolean;
  rewardName: string;
  rewardKind: DivinationRewardKind;
  rewardQuantity: number;
  /** rewardQuantity units of rewardName, on the sell route. */
  rewardChaosValue: number;
  rewardDivineValue?: number;
  /** cardChaosValue * stackSize - the full cost to buy one turn-in's worth of cards. */
  stackCostChaosValue: number;
  stackCostDivineValue?: number;
  /** rewardChaosValue - stackCostChaosValue. */
  profitChaosValue: number;
  profitDivineValue?: number;
  /** rewardChaosValue / stackCostChaosValue - 1. */
  profitPercent: number;
  confidence: LiquidityTier;
  /** Chaos per Divine Orb used to value divine legs. */
  divineChaosRate?: number;
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

/** A leg's exchange options at the hour's midpoint, times `quantity`; Chaos market first (pickRoute's tie-break). */
function exchangeLegs(item: ItemMarkets | undefined, quantity: number, divineRate: number | undefined): LegOption[] {
  const legs: LegOption[] = [];
  if (item?.chaos) {
    const mid = marketMid(item.chaos) * quantity;
    legs.push({
      source: "chaos",
      chaosValue: mid,
      divineValue: divineRate ? mid / divineRate : undefined,
      tier: liquidityTier(item.chaos.volumeChaos),
    });
  }
  if (item?.divine && divineRate) {
    const mid = marketMid(item.divine) * quantity;
    legs.push({ source: "divine", chaosValue: mid * divineRate, divineValue: mid, tier: liquidityTier(item.divine.volumeChaos) });
  }
  return legs;
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
 * profit percent. Skips a card entirely - rather than fabricating a number - whenever neither the
 * exchange nor poe.ninja prices the card right now, or the reward name doesn't match anything in
 * today's live price data (this is the second half of lib/divination-cards.ts's scoping rule: a
 * single-tag placeholder like "Axe" or "League-Specific Item" simply never matches a real item name).
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
  // One Divine rate for every conversion, so a Divine leg and a Chaos leg compare fairly: the
  // exchange's own, falling back to poe.ninja's when the exchange data is missing.
  const divineRate = quotes.divineChaosRate ?? currencyPrices.get("Divine Orb")?.chaosValue;
  const toDivine = (chaos: number) => (divineRate ? chaos / divineRate : undefined);
  const ninjaLeg = (chaosValue: number | undefined, tier: LiquidityTier): LegOption[] =>
    chaosValue !== undefined && chaosValue > 0 ? [{ source: "ninja", chaosValue, divineValue: toDivine(chaosValue), tier }] : [];
  const marketToChaos = (m: ItemMarket, v: number) => (m.currency === "chaos" ? v : v * (divineRate ?? 0));
  const marketToDivine = (m: ItemMarket, v: number) => (m.currency === "divine" ? v : toDivine(v));

  const flips: DivinationFlip[] = [];
  for (const def of DIVINATION_CARDS) {
    const cardMarkets = quotes.markets.get(def.name);
    let buys = exchangeLegs(cardMarkets, def.stackSize, divineRate);
    if (buys.length === 0) {
      // No exchange market for this card this hour - the same "low" a card with no market always got.
      const cardPrice = currencyPrices.get(def.name)?.chaosValue;
      buys = ninjaLeg(cardPrice !== undefined ? cardPrice * def.stackSize : undefined, "low");
    }

    let sells: LegOption[];
    if (def.rewardKind === "unique") {
      // Uniques aren't on the exchange: sold on the trade site for either currency at poe.ninja's price.
      const item = itemPrices.get(itemPriceKey(def.rewardName));
      sells = ninjaLeg(item ? item.chaosValue * def.rewardQuantity : undefined, sellerCountTier(item?.sellerCount));
    } else if (def.rewardName === "Chaos Orb") {
      // The pivot currency: worth exactly its count, with no market of its own to look up.
      sells = [{ source: "chaos", chaosValue: def.rewardQuantity, divineValue: toDivine(def.rewardQuantity), tier: "high" }];
    } else {
      // "currency" and "card" rewards both live in the exchange data and the same currency price
      // map - a card-to-card reward needs no separate lookup.
      sells = exchangeLegs(quotes.markets.get(def.rewardName), def.rewardQuantity, divineRate);
      if (sells.length === 0) {
        const priced = currencyPrices.get(def.rewardName)?.chaosValue;
        sells = ninjaLeg(priced !== undefined ? priced * def.rewardQuantity : undefined, "low");
      }
    }

    const route = pickRoute(buys, sells);
    if (!route) continue; // card or reward not (yet) priceable anywhere

    const buyMarket =
      route.buy.source === "chaos" ? cardMarkets?.chaos : route.buy.source === "divine" ? cardMarkets?.divine : undefined;
    const stackCostChaosValue = route.buy.chaosValue;
    const rewardChaosValue = route.sell.chaosValue;

    flips.push({
      name: def.name,
      stackSize: def.stackSize,
      buyIn: route.buy.source,
      sellIn: route.sell.source,
      cardChaosValue: stackCostChaosValue / def.stackSize,
      cardDivineValue: route.buy.divineValue !== undefined ? route.buy.divineValue / def.stackSize : undefined,
      buyMinChaosValue: buyMarket ? marketToChaos(buyMarket, buyMarket.low) : undefined,
      buyMaxChaosValue: buyMarket ? marketToChaos(buyMarket, buyMarket.high) : undefined,
      buyMinDivineValue: buyMarket ? marketToDivine(buyMarket, buyMarket.low) : undefined,
      buyMaxDivineValue: buyMarket ? marketToDivine(buyMarket, buyMarket.high) : undefined,
      faustusTradeable: isFaustusTradeable(def.name),
      rewardName: def.rewardName,
      rewardKind: def.rewardKind,
      rewardQuantity: def.rewardQuantity,
      rewardChaosValue,
      rewardDivineValue: route.sell.divineValue,
      stackCostChaosValue,
      stackCostDivineValue: route.buy.divineValue,
      profitChaosValue: rewardChaosValue - stackCostChaosValue,
      profitDivineValue:
        route.sell.divineValue !== undefined && route.buy.divineValue !== undefined
          ? route.sell.divineValue - route.buy.divineValue
          : undefined,
      profitPercent: (rewardChaosValue / stackCostChaosValue - 1) * 100,
      confidence: route.tier,
      divineChaosRate: divineRate,
    });
  }

  return flips.sort((a, b) => b.profitPercent - a.profitPercent);
}
