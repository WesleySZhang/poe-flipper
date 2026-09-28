"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ExchangeListings, ListingLevel } from "@/lib/trade-exchange";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "limited"; until: number }
  | { status: "loaded"; listings: ExchangeListings };

function formatPrice(price: number, currency: "chaos" | "divine"): string {
  const digits = price >= 100 ? 0 : price >= 10 ? 1 : price >= 1 ? 2 : 4;
  return `${Number(price.toFixed(digits))}${currency === "chaos" ? "c" : "d"}`;
}

function LevelList({ levels, currency }: { levels: ListingLevel[]; currency: "chaos" | "divine" }) {
  return (
    <ul className="flex flex-col gap-0.5 tabular-nums">
      {levels.map((l) => (
        <li key={l.price} className="flex justify-between gap-4">
          <span className="font-medium">{formatPrice(l.price, currency)}</span>
          <span className="text-muted-foreground" title={`${l.sellers} seller${l.sellers === 1 ? "" : "s"}`}>
            {l.stock.toLocaleString()} in stock
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * On-demand live listings from the official trade site's bulk exchange (lib/trade-exchange.ts):
 * each price with the stock listed at it. Only rendered for items the Currency Exchange covers.
 * The server rate-limits these searches for everyone at once, so a press can come back "retry in
 * Ns" instead of a result; the button counts that down.
 */
export function ExchangePriceButton({ name }: { name: string }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Tick the "retry in" countdown, then re-enable the button.
  useEffect(() => {
    if (state.status !== "limited") return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= state.until) setState({ status: "idle" });
    }, 500);
    return () => clearInterval(id);
  }, [state]);

  async function handleClick(e: React.MouseEvent) {
    // This can sit inside a click-to-expand row (see ItemHistoryRow) - don't also toggle it.
    e.stopPropagation();
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/exchange-listings?name=${encodeURIComponent(name)}`);
      if (res.status === 429) {
        const { retryAfterSeconds } = (await res.json()) as { retryAfterSeconds: number };
        setNow(Date.now());
        setState({ status: "limited", until: Date.now() + retryAfterSeconds * 1000 });
        return;
      }
      if (!res.ok) {
        setState({ status: "error", message: res.status === 404 ? "Not listed" : "Unavailable" });
        return;
      }
      setState({ status: "loaded", listings: await res.json() });
      setOpen(true);
    } catch {
      setState({ status: "error", message: "Unavailable" });
    }
  }

  if (state.status === "loaded") {
    const { chaos, divine } = state.listings;
    const cheapest = chaos[0] ? formatPrice(chaos[0].price, "chaos") : divine[0] ? formatPrice(divine[0].price, "divine") : undefined;
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button variant="outline" size="xs" onClick={(e) => e.stopPropagation()} title="Online listings on the trade site">
              {cheapest ?? "None listed"}
              <ChevronDown />
            </Button>
          }
        />
        <PopoverContent className="w-60" onClick={(e) => e.stopPropagation()}>
          <p className="text-xs text-muted-foreground">Online on the trade site</p>
          {chaos.length === 0 && divine.length === 0 && <p>No online listings</p>}
          {chaos.length > 0 && <LevelList levels={chaos} currency="chaos" />}
          {divine.length > 0 && <LevelList levels={divine} currency="divine" />}
        </PopoverContent>
      </Popover>
    );
  }

  const label =
    state.status === "limited"
      ? `Retry in ${Math.max(1, Math.ceil((state.until - now) / 1000))}s`
      : state.status === "error"
        ? state.message
        : "Exchange Price";
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={state.status === "loading" || state.status === "limited"}
      onClick={handleClick}
      title="Live listings from the trade site: each price and its stock"
    >
      {state.status === "loading" && <Loader2 className="animate-spin" />}
      {label}
    </Button>
  );
}
