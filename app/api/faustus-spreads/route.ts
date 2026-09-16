import { getFaustusSpreads } from "@/lib/faustus";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why. Backs the Currency Exchange Flip page - unlike the flip
// suggestions table, this has no per-day scenario parameter: the exchange data is always "the last
// closed hour", so there's nothing to project, only the current, live spread.
export async function GET() {
  const spreads = await getFaustusSpreads(CURRENT_LEAGUE);
  return Response.json(spreads);
}
