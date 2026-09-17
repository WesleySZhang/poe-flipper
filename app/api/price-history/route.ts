import { jsonResponse } from "@/lib/api-response";
import { getCurrencyPriceHistory, getItemPriceHistory } from "@/lib/price-history";

// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category");
  const name = searchParams.get("name");
  const variant = searchParams.get("variant") || undefined;

  if (category !== "currency" && category !== "item") {
    return jsonResponse({ error: "category must be 'currency' or 'item'" }, request, { status: 400 });
  }
  if (!name) {
    return jsonResponse({ error: "name is required" }, request, { status: 400 });
  }

  // Unlike predict-item, an empty result here is a normal, unremarkable state (an item that never
  // existed in any past league) rather than a user-facing error - the chart just renders its own
  // "no historical data" message for an empty array.
  const series =
    category === "currency" ? await getCurrencyPriceHistory(name) : await getItemPriceHistory(name, variant);
  return jsonResponse(series, request);
}
