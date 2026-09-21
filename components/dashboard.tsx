import { AppHeader } from "@/components/app-header";
import { FlipSuggestionsPanel } from "@/components/flip-suggestions-panel";

export function Dashboard() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader title="PoE Flipper" />
      <FlipSuggestionsPanel />
    </div>
  );
}
