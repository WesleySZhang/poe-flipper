import Link from "next/link";
import { FlipSuggestionsPanel } from "@/components/flip-suggestions-panel";
import { ThemeToggle } from "@/components/theme-toggle";

export function Dashboard() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-sans text-2xl font-semibold">PoE Flipper</h1>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/mirage-simulator"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Mirage league simulator
          </Link>
          <Link
            href="/current-league-tester"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            League tester
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <FlipSuggestionsPanel />
    </div>
  );
}
