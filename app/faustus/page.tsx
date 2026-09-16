import Link from "next/link";
import { FaustusSpreadsPanel } from "@/components/faustus-spreads-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

export default function FaustusPage() {
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
          <h1 className="mt-2 text-2xl font-semibold">Faustus spreads - {CURRENT_LEAGUE}</h1>
          <p className="text-sm text-muted-foreground">
            Buy/sell price spreads on GGG&apos;s Currency Exchange for same-day flipping - not a projection like the
            rest of this app, just what the exchange itself already shows about how far an item&apos;s price moved
            within the last hour it traded.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <FaustusSpreadsPanel />
    </div>
  );
}
