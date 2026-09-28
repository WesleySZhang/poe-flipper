import { AppHeader } from "@/components/app-header";
import { SoldListingsPanel } from "@/components/sold-listings-panel";

export default function SoldListingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader title="Sold Listings" />
      <SoldListingsPanel />
    </div>
  );
}
