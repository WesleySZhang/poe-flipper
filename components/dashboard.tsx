import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
          {/* Mirage simulator / league tester are both testing/simulation utilities, not
              same-day-actionable tools - grouped under one dropdown rather than two separate
              muted links, so the header doesn't read as five equally-weighted destinations. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
                  Testing
                  <ChevronDown className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent>
              <DropdownMenuItem render={<Link href="/mirage-simulator">Mirage league simulator</Link>} />
              <DropdownMenuItem render={<Link href="/current-league-tester">League tester</Link>} />
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Solid buttons, not muted text links - these are the tool's primary same-day-actionable
              features (real, live exchange spreads; real, live card-flip math), so both earn equal
              visual weight rather than one standing out as more important than the other. */}
          <Link href="/divination-cards" className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}>
            Divination Card Flips
          </Link>
          <Link href="/currency_exchange_flip" className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}>
            Currency Exchange Flip
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <FlipSuggestionsPanel />
    </div>
  );
}
