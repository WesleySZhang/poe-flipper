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
            Spot-check tool for one item at a time in the current (still ongoing) {CURRENT_LEAGUE} league. Since{" "}
            {CURRENT_LEAGUE} hasn&apos;t finished yet, this app has no day-by-day price history for it to compare
            against - so instead of a table, type in an item, the price you see for it on a given league day (from
            poe.ninja&apos;s site, which shows a per-item history chart the public API doesn&apos;t expose), and how
            many days ahead to project. This tells you what the model predicts; look up the actual price on that
            future day yourself on poe.ninja to see how close it got.
          </>
        }
      />
      <CurrentLeagueTesterPanel />
    </div>
  );
}
