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
 * Shared header for every real page of the app (not the login screen). The frame is identical on
 * every page so nothing shifts as you navigate: a top row (app name, search, theme toggle), then the
 * nav row with the current page's own button highlighted like the active tab in a tab bar
 * (usePathname is the single source of truth, so a new page only adds itself here once). The
 * page's own title sits below that frame - it varies in length (an item name can be long), so it
 * must not share a row with anything fixed.
 */
export function AppHeader({ title }: { title: string }) {
  const pathname = usePathname();
  const isTestingRoute = TESTING_ROUTES.includes(pathname);

  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Link href="/" className="shrink-0 text-lg font-semibold">
          PoE Flipper
        </Link>
        {/* Phone: an icon here that opens an overlay; sm+: the long inline box fills the row. */}
        <div className="ml-auto flex items-center gap-2 sm:ml-0 sm:flex-1">
          <GlobalSearch variant="mobile" />
          <GlobalSearch variant="desktop" />
        </div>
        <ThemeToggle />
      </div>
      {/* flex-wrap so a narrow phone wraps the buttons onto a second line instead of overflowing
          the page sideways. */}
      <nav className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:gap-4">
        <NavButton href="/" active={pathname === "/"}>
          Flip Suggestions
        </NavButton>
        <NavButton href="/currency_exchange_flip" active={pathname === "/currency_exchange_flip"}>
          Currency Exchange Flip
        </NavButton>
        <NavButton href="/divination-cards" active={pathname === "/divination-cards"}>
          Divination Card Flips
        </NavButton>
        {/* Mirage simulator / league tester are testing utilities, not same-day-actionable tools -
            grouped under one dropdown so the nav doesn't read as five equal destinations. The
            trigger highlights when either page is current; it opens on hover or click. */}
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
      </nav>
      <h1 className="text-2xl font-semibold">{title}</h1>
    </header>
  );
}
