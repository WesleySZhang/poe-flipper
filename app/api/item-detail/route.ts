import { jsonResponse } from "@/lib/api-response";
import { getItemDetail } from "@/lib/item-detail";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

// The per-item detail page's (components/item-detail-panel.tsx) one fetch for everything that
// doesn't depend on the chosen "Days ahead" duration - see lib/item-detail.ts's own module doc for
// why that's a separate concern from price/ratio/confidence, which the panel gets from the existing
// precomputed-predictions machinery instead.
//
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

  const detail = await getItemDetail(CURRENT_LEAGUE, category, name, variant);
  if (!detail) {
    return jsonResponse({ error: "no live price for this item right now" }, request, { status: 404 });
  }
  return jsonResponse(detail, request);
}
