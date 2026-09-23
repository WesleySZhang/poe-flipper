import "server-only";
import { DIVINATION_CARDS, type DivinationRewardKind } from "./divination-cards";
import { getAllCurrentCurrencyPrices, getAllCurrentItemPrices, itemPriceKey } from "./poe-ninja";
import { getActiveTypes } from "./price-snapshot";
import { getFaustusSpreads, isFaustusTradeable, type FaustusSpread } from "./faustus";
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
 */
export interface DivinationFlip {
  name: string;
  stackSize: number;
  /** poe.ninja's live per-card price - the primary buy-side source (cards are bought via the
   *  Currency Exchange, but poe.ninja's stash-scrape price is what's shown by default; see
   *  buyMin/MaxChaosValue below for the Currency Exchange's own historical range). */
  cardChaosValue: number;
  cardDivineValue?: number;
  /** GGG's Currency Exchange (Faustus) hour-range low/high for the card itself - undefined when no
   *  Faustus market exists for this card right now (see faustusTradeable). */
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
  /** rewardQuantity units of rewardName, at today's live price. */
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
  const [currencyPrices, itemPrices, faustusSpreads] = await Promise.all([
    getAllCurrentCurrencyPrices(league, activeTypes.currency),
    getAllCurrentItemPrices(league, activeTypes.item),
    getFaustusSpreads(league),
  ]);
  const spreadByName = new Map<string, FaustusSpread>(faustusSpreads.map((s) => [s.name, s]));

  const flips: DivinationFlip[] = [];
  for (const def of DIVINATION_CARDS) {
    const cardPrice = currencyPrices.get(def.name);
    if (!cardPrice || !(cardPrice.chaosValue > 0)) continue; // poe.ninja isn't pricing this card right now

    let rewardChaosPerUnit: number | undefined;
    let rewardConfidence: LiquidityTier;
    if (def.rewardKind === "unique") {
      const item = itemPrices.get(itemPriceKey(def.rewardName));
      rewardChaosPerUnit = item?.chaosValue;
      rewardConfidence = sellerCountTier(item?.sellerCount);
    } else {
      // "currency" and "card" rewards both live in the same currency price map - a divination
      // card's own price (DivinationCard type) is fetched from the same getAllCurrentCurrencyPrices
      // call this app already uses for currency, so a card-to-card reward needs no separate lookup.
      const priced = currencyPrices.get(def.rewardName);
      rewardChaosPerUnit = priced?.chaosValue;
      const rewardSpread = spreadByName.get(def.rewardName);
      rewardConfidence = rewardSpread ? liquidityTier(rewardSpread.volumeChaos) : "low";
    }
    if (rewardChaosPerUnit === undefined || !(rewardChaosPerUnit > 0)) continue; // reward not (yet) priceable

    const cardSpread = spreadByName.get(def.name);
    const cardConfidence: LiquidityTier = cardSpread ? liquidityTier(cardSpread.volumeChaos) : "low";

    const rewardChaosValue = rewardChaosPerUnit * def.rewardQuantity;
    const stackCostChaosValue = cardPrice.chaosValue * def.stackSize;
    const profitChaosValue = rewardChaosValue - stackCostChaosValue;

    // Divine-denominated figures need a live Divine Orb rate - falls back to undefined (not a
    // fabricated 0) if it's missing, same "graceful when a secondary source is missing" pattern
    // FlipSuggestion.currentDivineValue already uses.
    const divineRate = currencyPrices.get("Divine Orb")?.chaosValue;
    const toDivine = (chaos: number) => (divineRate ? chaos / divineRate : undefined);

    flips.push({
      name: def.name,
      stackSize: def.stackSize,
      cardChaosValue: cardPrice.chaosValue,
      cardDivineValue: toDivine(cardPrice.chaosValue),
      buyMinChaosValue: cardSpread?.buyChaosValue,
      buyMaxChaosValue: cardSpread?.sellChaosValue,
      buyMinDivineValue: cardSpread?.buyDivineValue,
      buyMaxDivineValue: cardSpread?.sellDivineValue,
      faustusTradeable: isFaustusTradeable(def.name),
      rewardName: def.rewardName,
      rewardKind: def.rewardKind,
      rewardQuantity: def.rewardQuantity,
      rewardChaosValue,
      rewardDivineValue: toDivine(rewardChaosValue),
      stackCostChaosValue,
      stackCostDivineValue: toDivine(stackCostChaosValue),
      profitChaosValue,
      profitDivineValue: toDivine(profitChaosValue),
      profitPercent: (rewardChaosValue / stackCostChaosValue - 1) * 100,
      confidence: weakerTier(cardConfidence, rewardConfidence),
    });
  }

  return flips.sort((a, b) => b.profitPercent - a.profitPercent);
}
