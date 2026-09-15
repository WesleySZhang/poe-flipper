"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPriceValue, type PriceUnit } from "@/lib/price-unit";

interface FaustusPriceResponse {
  chaosValue: number;
  divineValue?: number;
}

type State = { status: "idle" } | { status: "loading" } | { status: "error" } | { status: "loaded"; price: FaustusPriceResponse };

/**
 * On-demand cross-check against GGG's own Currency Exchange (Faustus) trade data - only rendered
 * for the small, evergreen currency subset it actually covers (see lib/faustus.ts), so a click here
 * should basically always succeed; the error state exists for the rare case the exchange had no
 * recent trades for this specific currency.
 */
export function FaustusPriceButton({ name, priceUnit }: { name: string; priceUnit: PriceUnit }) {
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleClick() {
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/faustus-price?name=${encodeURIComponent(name)}`);
      if (!res.ok) {
        setState({ status: "error" });
        return;
      }
      setState({ status: "loaded", price: await res.json() });
    } catch {
      setState({ status: "error" });
    }
  }

  if (state.status === "loaded") {
    return (
      <span className="text-sm tabular-nums" title="From GGG's Currency Exchange (Faustus), not poe.ninja">
        {formatPriceValue(state.price.chaosValue, state.price.divineValue, priceUnit)}
      </span>
    );
  }

  return (
    <Button
      variant="outline"
      size="xs"
      disabled={state.status === "loading"}
      onClick={handleClick}
      title="Fetch this currency's price from GGG's Currency Exchange (Faustus) instead of poe.ninja"
    >
      {state.status === "loading" && <Loader2 className="animate-spin" />}
      {state.status === "error" ? "Unavailable" : "Exchange Price"}
    </Button>
  );
}
