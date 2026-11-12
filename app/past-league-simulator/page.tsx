import { AppHeader } from "@/components/app-header";
import { PastLeagueSimulatorPanel } from "@/components/past-league-simulator-panel";

export default function PastLeagueSimulatorPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader title="Past league simulator" />
      <PastLeagueSimulatorPanel />
    </div>
  );
}
