import { AppHeader } from "@/components/app-header";
import { CurrencyExchangeFlipPanel } from "@/components/currency-exchange-flip-panel";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

export default function FaustusPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader
        title="Currency Exchange Flip"
        description={
          <>
            Buy/sell price spreads on GGG&apos;s Currency Exchange (the &quot;Faustus&quot; NPC) for same-day
            flipping in {CURRENT_LEAGUE} - not a projection like the rest of this app, just what the exchange itself
            already shows about how far an item&apos;s price moved within the last hour it traded.
          </>
        }
      />
      <CurrencyExchangeFlipPanel />
    </div>
  );
}
