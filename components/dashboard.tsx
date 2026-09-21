import Link from "next/link";
import { cn } from "cn";
import { buttonVariants } from "@/components/ui/button";
import { FlipSuggestionsPanel } from "@/components/flip-suggestions-panel";
import { ThemeToggle } from "@/components/theme-toggle";

export function Dashboard() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
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
          <Link
            href="/divination-cards"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Divination card flips
          </Link>
          {/* Solid button, not a muted text link like the other two - this is the tool's primary
              same-day-actionable feature (real, live exchange spreads), not a secondary testing/
              simulation utility, so it earns the visual weight. */}
          <Link href="/currency_exchange_flip" className={cn(buttonVariants({ variant: "default", size: "sm" }))}>
            Currency Exchange Flip
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <FlipSuggestionsPanel />
    </div>
  );
}
