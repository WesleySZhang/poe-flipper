import { getFaustusPrice } from "@/lib/faustus";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why. Backs the flip-suggestions table's on-demand
// "Faustus Price" button - fetched only when clicked, rather than upfront for every row, since most
// rows already have a poe.ninja price and never need this at all.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name");
  if (!name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  const price = await getFaustusPrice(name, CURRENT_LEAGUE);
  if (!price) {
    return Response.json(
      { error: "No Faustus (Currency Exchange) price available for this item right now." },
      { status: 404 }
    );
  }

  return Response.json(price);
}
