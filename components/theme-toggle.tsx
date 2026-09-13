"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

const noopSubscribe = () => () => {};

/** False during SSR/hydration, true once running in the browser - there's no store to subscribe
 *  to here, just a one-time environment check, but useSyncExternalStore is the React-sanctioned
 *  way to make that check without a client/server render mismatch. */
function useHasMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // Avoids a hydration mismatch: the server has no way to know the user's system/stored
  // preference, so render nothing until mounted on the client.
  const mounted = useHasMounted();

  if (!mounted) return <Button variant="ghost" size="icon-sm" aria-hidden className="opacity-0" />;

  const isDark = resolvedTheme === "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
