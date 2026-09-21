import { jsonResponse } from "@/lib/api-response";
import { getDivinationFlips } from "@/lib/divination-flips";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why. Same "no per-day scenario parameter" shape as
// app/api/faustus-spreads/route.ts - card and reward prices are both live, current-moment reads,
// so there's nothing to project, only today's actual flip opportunities.
export async function GET(request: Request) {
  const flips = await getDivinationFlips(CURRENT_LEAGUE);
  return jsonResponse(flips, request);
}
