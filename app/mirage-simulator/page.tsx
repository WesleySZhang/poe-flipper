import Link from "next/link";
import { MirageSimulatorPanel } from "@/components/mirage-simulator-panel";
import { ThemeToggle } from "@/components/theme-toggle";

export default function MirageSimulatorPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            &larr; Dashboard
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Mirage league simulator</h1>
          <p className="text-sm text-muted-foreground">
            Testing tool - replays the flip-suggestion model against the (already finished) Mirage league, which is
            always held out of training, so you can see how its predictions compare to what actually happened.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <MirageSimulatorPanel />
    </div>
  );
}
