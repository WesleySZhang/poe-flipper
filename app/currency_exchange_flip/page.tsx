import { AppHeader } from "@/components/app-header";
import { CurrencyExchangeFlipPanel } from "@/components/currency-exchange-flip-panel";

export default function FaustusPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader title="Currency Exchange Flip" />
      <CurrencyExchangeFlipPanel />
    </div>
  );
}
