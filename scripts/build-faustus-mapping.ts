/**
 * One-off research script (not part of the app) - validates a hand-built name<->metadata-id
 * mapping candidate list against live GGG Currency Exchange data, since GGG's endpoint never
 * exposes a display name itself (see lib/faustus.ts for why) and pure price-correlation proved far
 * too unreliable at this scale (hundreds of unrelated items share a similar chaos value at any given
 * hour - an earlier version of this script that matched purely by price produced obviously wrong
 * pairings, e.g. Glassblower's Bauble matched to a Heist currency worth the same that hour).
 *
 * The candidate list below is built from GGG's own long-established internal naming convention
 * (CurrencyReroll, CurrencyUpgrade, CurrencyAddMod prefixes etc. - stable across years of the
 * game), not from this script. This script only checks each candidate: does the id exist in live Allflame
 * data at all, and is its computed chaos-equivalent (via a Chaos or Divine Orb pair) roughly in
 * line with poe.ninja's own already-trusted price for that name - a sanity check against a
 * misidentified id, not a discovery mechanism.
 */
import { getAllCurrentCurrencyPrices } from "../lib/poe-ninja";
import { CURRENT_LEAGUE } from "../lib/league-recency";
import { FAUSTUS_NAME_TO_ID } from "../lib/faustus";

const EXCHANGE_URL = "https://web.poecdn.com/api/currency-exchange";
const CHAOS_ID = "Metadata/Items/Currency/CurrencyRerollRare";
const DIVINE_ID = "Metadata/Items/Currency/CurrencyModValues";

interface Market {
  league: string;
  market_pair: [string, string];
  volume_traded: Record<string, number>;
  lowest_ratio: Record<string, number>;
  highest_ratio: Record<string, number>;
}

async function fetchRecentMarkets(): Promise<Market[]> {
  const hourTs = Math.floor(Date.now() / 1000 / 3600) * 3600 - 2 * 3600;
  const res = await fetch(`${EXCHANGE_URL}/${hourTs}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`GGG exchange endpoint returned ${res.status}`);
  const data = (await res.json()) as { markets: Market[] };
  return data.markets.filter((m) => m.league === CURRENT_LEAGUE);
}

function rateFromPair(m: Market, id: string, chaosSideId: string): number | undefined {
  if (!m.market_pair.includes(id) || !m.market_pair.includes(chaosSideId)) return undefined;
  const idLow = m.lowest_ratio[id];
  const idHigh = m.highest_ratio[id];
  const chaosLow = m.lowest_ratio[chaosSideId];
  const chaosHigh = m.highest_ratio[chaosSideId];
  if (!idLow || !idHigh || !chaosLow || !chaosHigh) return undefined;
  return (chaosLow / idHigh + chaosHigh / idLow) / 2;
}

async function main() {
  const [markets, ourPrices] = await Promise.all([fetchRecentMarkets(), getAllCurrentCurrencyPrices(CURRENT_LEAGUE)]);
  console.log(`Fetched ${markets.length} Allflame markets from GGG, ${ourPrices.size} known currency prices.\n`);

  const divineChaosRate = (() => {
    for (const m of markets) {
      const r = rateFromPair(m, DIVINE_ID, CHAOS_ID);
      if (r) return r;
    }
    return undefined;
  })();
  console.log("Divine Orb chaos rate (from GGG data):", divineChaosRate, "\n");

  for (const [name, id] of Object.entries(FAUSTUS_NAME_TO_ID)) {
    const ourPrice = ourPrices.get(name);
    let best: { chaosValue: number; volume: number; via: string } | undefined;
    for (const m of markets) {
      const volume = m.volume_traded[id] ?? 0;
      const viaChaos = rateFromPair(m, id, CHAOS_ID);
      const viaDivine = divineChaosRate ? rateFromPair(m, id, DIVINE_ID) : undefined;
      const candidate =
        viaChaos !== undefined
          ? { chaosValue: viaChaos, volume, via: "chaos" }
          : viaDivine !== undefined && divineChaosRate
            ? { chaosValue: viaDivine * divineChaosRate, volume, via: "divine" }
            : undefined;
      if (candidate && (!best || candidate.volume > best.volume)) best = candidate;
    }

    if (!best) {
      console.log(`${name.padEnd(30)} id=${id.padEnd(55)} NOT FOUND in live Allflame exchange data`);
      continue;
    }
    const pct = ourPrice ? (((best.chaosValue - ourPrice.chaosValue) / ourPrice.chaosValue) * 100).toFixed(1) : "n/a";
    const flag = ourPrice && Math.abs(Number(pct)) > 20 ? "  <-- CHECK THIS" : "";
    console.log(
      `${name.padEnd(30)} id=${id.padEnd(55)} computed=${best.chaosValue.toFixed(3)}c ours=${ourPrice?.chaosValue.toFixed(3) ?? "?"}c diff=${pct}% vol=${best.volume} via=${best.via}${flag}`
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
