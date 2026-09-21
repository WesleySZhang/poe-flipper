import { AppHeader } from "@/components/app-header";
import { CurrentLeagueTesterPanel } from "@/components/current-league-tester-panel";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

export default function CurrentLeagueTesterPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader
        title={`${CURRENT_LEAGUE} tester`}
        description={
          <>
            Spot-check tool for one item at a time in the current, still-ongoing {CURRENT_LEAGUE} league - type in an
            item, a price, and a day, and compare the model&apos;s prediction against poe.ninja&apos;s actual chart.
          </>
        }
      />
      <CurrentLeagueTesterPanel />
    </div>
  );
}
