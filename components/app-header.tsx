"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/theme-toggle";

interface NavButtonProps {
  href: string;
  active: boolean;
  children: React.ReactNode;
}

/** One top-level nav destination - the active page's own button is styled like the previously
 *  black "primary" flip buttons (bg-primary, near-black in light mode), every other one falls
 *  back to the softer "secondary" style, so at a glance the highlighted button reads as "you are
 *  here", not just "this one happens to be important". */
function NavButton({ href, active, children }: NavButtonProps) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant: active ? "default" : "secondary", size: "sm" }))}>
      {children}
    </Link>
  );
}

// Every route this dropdown covers - used both to render its items and to decide whether the
// dropdown's OWN trigger should highlight as "active" (i.e. is one of its pages the current one).
const TESTING_ROUTES = ["/mirage-simulator", "/current-league-tester"];

/**
 * Shared header/nav for every real page of the app (not the login screen, which has nowhere to
 * navigate to yet) - lets you jump directly from any page to any other, with the current page's
 * own button highlighted the same way a browser tab bar highlights the active tab. Replaces the
 * old per-page "<- Dashboard" back-link, which only ever went one way and didn't scale past two
 * pages. usePathname (not a passed-in prop) is the single source of truth for which button is
 * active, so a new page only ever needs to add itself here once, not thread active-state through
 * every page's own top-level component.
 */
export function AppHeader({ title, description }: { title: string; description?: React.ReactNode }) {
  const pathname = usePathname();
  const isTestingRoute = TESTING_ROUTES.includes(pathname);

  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="flex items-center gap-4">
        <NavButton href="/" active={pathname === "/"}>
          Flip Suggestions
        </NavButton>
        <NavButton href="/currency_exchange_flip" active={pathname === "/currency_exchange_flip"}>
          Currency Exchange Flip
        </NavButton>
        <NavButton href="/divination-cards" active={pathname === "/divination-cards"}>
          Divination Card Flips
        </NavButton>
        {/* Mirage simulator / league tester are both testing/simulation utilities, not
            same-day-actionable tools - grouped under one dropdown rather than two separate nav
            buttons, so the header doesn't read as five equally-weighted destinations. The trigger
            itself highlights active (same default/secondary styling as the other buttons) whenever
            either of its pages is the current one, so "where am I" still holds even collapsed. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant={isTestingRoute ? "default" : "secondary"} size="sm">
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
        <ThemeToggle />
      </div>
    </header>
  );
}
