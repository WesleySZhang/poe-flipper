import { AppHeader } from "@/components/app-header";
import { FlipSuggestionsPanel } from "@/components/flip-suggestions-panel";

export function Dashboard() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader
        title="PoE Flipper"
        description="Ranks items and currency by projected growth from a chosen day of the current league over a chosen number of days, using a learned model trained on how prices actually moved in past leagues."
      />
      <FlipSuggestionsPanel />
    </div>
  );
}
