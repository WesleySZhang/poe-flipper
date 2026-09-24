"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { GlobalSearch } from "@/components/global-search";
import { ThemeToggle } from "@/components/theme-toggle";

const NAV_LINKS = [
  { href: "/", label: "Flip Suggestions" },
  { href: "/currency_exchange_flip", label: "Currency Exchange Flip" },
  { href: "/divination-cards", label: "Divination Card Flips" },
];

// Testing/simulation utilities, not same-day-actionable tools - grouped under one "Testing" menu so
// the nav doesn't read as five equal destinations.
const TESTING_LINKS = [
  { href: "/mirage-simulator", label: "Mirage league simulator" },
  { href: "/current-league-tester", label: "League tester" },
];

/**
 * Shared header for every real page of the app (not the login screen): a standard top bar - app
 * name, nav, search, theme toggle - with the current page's link highlighted (usePathname is the
 * single source of truth, so a new page only adds itself to the lists above). The frame is
 * identical on every page so nothing shifts as you navigate; the page's own title sits below it,
 * since it varies in length (an item name can be long) and must not share a row with anything
 * fixed. Below `xl` the links don't fit beside the search box, so they move into a side sheet
 * opened by the menu button.
 */
export function AppHeader({ title }: { title: string }) {
  const pathname = usePathname();
  const [sheetOpen, setSheetOpen] = useState(false);
  const isTestingRoute = TESTING_LINKS.some((l) => l.href === pathname);

  return (
    <header className="flex flex-col gap-4">
      <div className="flex h-12 items-center gap-3 border-b border-border pb-1 sm:gap-4">
        {/* Left of the name (the usual spot for a menu button), below xl only. */}
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger
            render={
              <Button variant="ghost" size="icon-sm" className="xl:hidden" aria-label="Pages">
                <Menu />
              </Button>
            }
          />
          <SheetContent side="left">
            <SheetHeader>
              <SheetTitle>Pages</SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col gap-1 px-4" aria-label="Pages">
              {[...NAV_LINKS, ...TESTING_LINKS].map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setSheetOpen(false)}
                  className={cn(
                    "rounded-md px-2 py-2 text-sm hover:bg-muted",
                    pathname === l.href ? "bg-muted font-medium" : "text-muted-foreground"
                  )}
                >
                  {l.label}
                </Link>
              ))}
            </nav>
          </SheetContent>
        </Sheet>
        <Link href="/" className="shrink-0 text-lg font-semibold">
          PoE Flipper
        </Link>

        <NavigationMenu className="hidden xl:flex" aria-label="Pages">
          <NavigationMenuList>
            {NAV_LINKS.map((l) => (
              <NavigationMenuItem key={l.href}>
                <NavigationMenuLink
                  active={pathname === l.href}
                  render={<Link href={l.href} />}
                  className={cn("px-3 py-1.5 font-medium", pathname !== l.href && "text-muted-foreground")}
                >
                  {l.label}
                </NavigationMenuLink>
              </NavigationMenuItem>
            ))}
            <NavigationMenuItem>
              <NavigationMenuTrigger className={cn(isTestingRoute ? "bg-muted/50" : "text-muted-foreground")}>
                Testing
              </NavigationMenuTrigger>
              <NavigationMenuContent>
                <ul className="flex w-56 flex-col">
                  {TESTING_LINKS.map((l) => (
                    <li key={l.href}>
                      <NavigationMenuLink active={pathname === l.href} render={<Link href={l.href} />}>
                        {l.label}
                      </NavigationMenuLink>
                    </li>
                  ))}
                </ul>
              </NavigationMenuContent>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>

        {/* Theme toggle sits LEFT of the search, so nothing next to the box reads as its submit
            button. Phone: search is an icon that opens an overlay; sm+: the inline box. */}
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <GlobalSearch variant="mobile" />
          <GlobalSearch variant="desktop" />
        </div>
      </div>
      <h1 className="text-2xl font-semibold">{title}</h1>
    </header>
  );
}
