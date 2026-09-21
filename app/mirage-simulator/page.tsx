import { AppHeader } from "@/components/app-header";
import { MirageSimulatorPanel } from "@/components/mirage-simulator-panel";

export default function MirageSimulatorPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader
        title="Mirage league simulator"
        description="Testing tool - replays the flip-suggestion model against the (already finished) Mirage league, which is always held out of training, so you can see how its predictions compare to what actually happened."
      />
      <MirageSimulatorPanel />
    </div>
  );
}
