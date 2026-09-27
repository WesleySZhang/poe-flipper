import { cachedJsonResponse } from "@/lib/api-response";
import { getDustValues } from "@/lib/dust-value";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

// A plain read, same shape as app/api/divination-flips/route.ts: live prices, nothing to project.
// Same TTL as getDustValues's own cache.
export async function GET(request: Request) {
  return cachedJsonResponse("dust-value", 60 * 1000, request, () => getDustValues(CURRENT_LEAGUE));
}
