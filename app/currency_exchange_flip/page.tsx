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
            Buy/sell price spreads on GGG&apos;s Currency Exchange for same-day flipping in {CURRENT_LEAGUE} - not a
            projection, just what the exchange itself shows about how far a price moved within the last hour.
          </>
        }
      />
      <CurrencyExchangeFlipPanel />
    </div>
  );
}
