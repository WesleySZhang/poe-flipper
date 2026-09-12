import Link from "next/link";
import { MirageSimulatorPanel } from "@/components/mirage-simulator-panel";

export default function MirageSimulatorPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header>
        <Link href="/" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
          &larr; Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Mirage league simulator</h1>
        <p className="text-sm text-muted-foreground">
          Testing tool - replays the flip-suggestion model against the (already finished) Mirage league, which is
          always held out of training, so you can see how its predictions compare to what actually happened.
        </p>
      </header>

      <MirageSimulatorPanel />
    </div>
  );
}
