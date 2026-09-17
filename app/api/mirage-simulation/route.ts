import { jsonResponse } from "@/lib/api-response";
import { simulateMirageLeague } from "@/lib/mirage-simulator";

// A plain read - deliberately a Route Handler rather than a Server Action. In Next's dev server,
// Server Actions re-instantiate their module graph on every invocation, which defeated the
// dayed-table caching in growth-ratios.ts (every call re-scanned the full price history). Route
// Handlers don't have that problem, and reads belong here anyway per Next's own guidance -
// Server Actions are for mutations.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const currentDay = Number(searchParams.get("currentDay"));
  const durationDays = Number(searchParams.get("durationDays"));

  if (!Number.isFinite(currentDay) || !Number.isFinite(durationDays)) {
    return jsonResponse({ error: "currentDay and durationDays must be numbers" }, request, { status: 400 });
  }

  const rows = await simulateMirageLeague(currentDay, durationDays);
  return jsonResponse(rows, request);
}
