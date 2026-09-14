import Link from "next/link";
import { CurrentLeagueTesterPanel } from "@/components/current-league-tester-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

export default function CurrentLeagueTesterPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            &larr; Dashboard
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">{CURRENT_LEAGUE} tester</h1>
          <p className="text-sm text-muted-foreground">
            Testing tool - replays the flip-suggestion model against any day of the current (still ongoing){" "}
            {CURRENT_LEAGUE} league, priced off today&apos;s real live values. Since {CURRENT_LEAGUE} hasn&apos;t
            finished yet, there&apos;s no historical record of what actually happens later in it - Actual future and
            Actual % can&apos;t be filled in, unlike the Mirage simulator.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <CurrentLeagueTesterPanel />
    </div>
  );
}
