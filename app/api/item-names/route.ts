import { getKnownNames } from "@/lib/growth-ratios";
import { formatItemDisplayName } from "@/lib/poe-ninja";

// A plain read - deliberately a Route Handler rather than a Server Action; see the comment in
// app/api/mirage-simulation/route.ts for why. Powers the current-league tester's item picker.
export async function GET() {
  const names = await getKnownNames();
  // Precomputed here (server-side, where lib/poe-ninja.ts is already used) rather than in the
  // client picker, so the client bundle never needs to import that module at all.
  return Response.json(
    names.map((n) => ({ ...n, displayName: formatItemDisplayName(n.name, n.variant) }))
  );
}
