"use server";

import { getSession } from "@/lib/session";
import { getFlipSuggestions, type FlipSuggestion } from "@/lib/flip-suggestions";

export async function fetchFlipSuggestions(): Promise<FlipSuggestion[]> {
  const session = await getSession();
  if (!session.league) return [];
  return getFlipSuggestions(session.league);
}
