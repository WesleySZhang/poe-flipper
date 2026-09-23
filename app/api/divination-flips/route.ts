import { cachedJsonResponse } from "@/lib/api-response";
import { getDivinationFlips } from "@/lib/divination-flips";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why. Same "no per-day scenario parameter" shape as
// app/api/faustus-spreads/route.ts - card and reward prices are both live, current-moment reads,
// so there's nothing to project, only today's actual flip opportunities.
//
// cachedJsonResponse (not plain jsonResponse) - this list is fetched both by the Divination Card
// Flips table and by every divination card's own detail page, so its JSON.stringify/gzip cost
// (getDivinationFlips's own result is already cached/coalesced) would otherwise be repeated on
// every single request regardless. Same TTL as getDivinationFlips's own cache - no point caching
// the serialized bytes any longer than the data behind them is considered fresh.
export async function GET(request: Request) {
  return cachedJsonResponse("divination-flips", 60 * 1000, request, () => getDivinationFlips(CURRENT_LEAGUE));
}
