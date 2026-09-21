import Link from "next/link";
import { DivinationFlipsPanel } from "@/components/divination-flips-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

export default function DivinationCardsPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            &larr; Dashboard
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Divination Card Flips</h1>
          <p className="text-sm text-muted-foreground">
            Buying a full stack of a card and turning it in for its reward, in {CURRENT_LEAGUE} - ranked by how
            much cheaper the stack is than the reward is worth right now. Only cards with a single, deterministic
            reward are shown; see the note below the price toggle for why.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <DivinationFlipsPanel />
    </div>
  );
}
