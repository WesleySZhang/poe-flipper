import { jsonResponse } from "@/lib/api-response";
import { getExchangeListings } from "@/lib/trade-exchange";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

// A plain read, fetched only when someone presses the Exchange Price button - see
// lib/trade-exchange.ts. A 429 here is this app's own limiter refusing (or passing on the trade
// site's), with the seconds to wait.
export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name");
  if (!name) return jsonResponse({ error: "name is required" }, request, { status: 400 });

  const result = await getExchangeListings(name, CURRENT_LEAGUE);
  switch (result.status) {
    case "ok":
      return jsonResponse(result.listings, request);
    case "unknown":
      return jsonResponse({ error: "Not on the trade site's bulk exchange." }, request, { status: 404 });
    case "limited":
      return jsonResponse({ retryAfterSeconds: result.retryAfterSeconds }, request, {
        status: 429,
        headers: { "Retry-After": String(result.retryAfterSeconds) },
      });
    case "error":
      return jsonResponse({ error: result.message }, request, { status: 502 });
  }
}
