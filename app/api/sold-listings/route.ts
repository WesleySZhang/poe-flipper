import { cachedJsonResponse } from "@/lib/api-response";
import { CURRENT_LEAGUE } from "@/lib/league-recency";
import { getSoldListings } from "@/lib/sold-listings";

// The tracker's published file plus today's currency rates; same TTL as getSoldListings's own cache.
export async function GET(request: Request) {
  return cachedJsonResponse("sold-listings", 5 * 60 * 1000, request, () => getSoldListings(CURRENT_LEAGUE));
}
