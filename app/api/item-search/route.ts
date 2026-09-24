import { jsonResponse } from "@/lib/api-response";
import { searchItems } from "@/lib/item-search";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

const MAX_RESULTS = 8;
const MAX_QUERY_LENGTH = 60;

// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why. Powers the header's global search (components/global-search.tsx).
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (!q.trim() || q.length > MAX_QUERY_LENGTH) return jsonResponse([], request);
  return jsonResponse(await searchItems(CURRENT_LEAGUE, q, MAX_RESULTS), request);
}
