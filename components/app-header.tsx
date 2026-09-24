"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { GlobalSearch } from "@/components/global-search";
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
 *
 * Deliberately just a title - no per-page description text. An earlier version had one, but pages'
 * descriptions varied enough in length that the header's height (and so the nav row's position)
 * visibly shifted between pages, which defeats the point of a shared, fixed nav; a page that still
 * needs to explain itself does so in its own panel instead.
 */
export function AppHeader({ title }: { title: string }) {
  const pathname = usePathname();
  const isTestingRoute = TESTING_ROUTES.includes(pathname);

  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      {/* sm:contents - at sm+ this wrapper disappears from layout entirely, so h1 and the
          (by-then-hidden) mobile toggle below become direct children of the header's own flex row,
          restoring the exact single-row "title -- nav -- toggle" desktop layout. Below sm, it's a
          real flex row of its own: title and the toggle pinned to the top-right corner, right next
          to it - a fixed, predictable spot instead of wherever the toggle happens to land after the
          nav row (which wraps independently, see below) breaks onto a second or third line. */}
      <div className="flex items-center justify-between gap-4 sm:contents">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {/* Phone: search icon sits in the top-right corner next to the theme toggle. */}
        <div className="flex items-center gap-2 sm:contents">
          <GlobalSearch variant="mobile" />
          <div className="sm:hidden">
            <ThemeToggle />
          </div>
        </div>
      </div>
      {/* flex-wrap (not a single unbreakable row) - on a narrow phone, four nav destinations are
          wider than the screen; without this the row silently overflowed the page horizontally
          instead of visibly wrapping, so "seeing the whole header" meant scrolling the entire page
          sideways (and dragging every other section along with it) rather than just reading a
          second line of buttons here. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:gap-4">
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
            either of its pages is the current one, so "where am I" still holds even collapsed.
            openOnHover shows its contents on hover (with a short delay so brushing past it on the
            way to another button doesn't pop it open), not just on click. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            openOnHover
            delay={150}
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
        {/* Hidden below sm - the mobile-only instance above (pinned next to the title) takes over
            there instead. Both are just <ThemeToggle> - it reads/writes the same shared theme
            context either way, so having two mounted instances (only one ever visible at a time) is
            safe. */}
        <GlobalSearch variant="desktop" />
        <div className="hidden sm:block">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
