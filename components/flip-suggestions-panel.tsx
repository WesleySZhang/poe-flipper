"use client";

import { useEffect, useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchFlipSuggestions } from "@/app/actions/flip-suggestions";
import type { FlipSuggestion } from "@/lib/flip-suggestions";
import type { SessionState } from "@/app/actions/login";

export function FlipSuggestionsPanel({ session }: { session: SessionState }) {
  const [suggestions, setSuggestions] = useState<FlipSuggestion[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!session.loggedIn) return;
    startTransition(async () => {
      setSuggestions(await fetchFlipSuggestions());
    });
  }, [session.loggedIn, session.league]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Flip suggestions</CardTitle>
        <CardDescription>
          Ranked by historical league-start to league-end growth for {session.league ?? "your league"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!session.loggedIn && (
          <p className="text-sm text-muted-foreground">Connect your account above to see suggestions.</p>
        )}
        {isPending && <Skeleton className="h-48 w-full" />}
        {!isPending && session.loggedIn && suggestions.length === 0 && (
          <p className="text-sm text-muted-foreground">No historical matches found for current live prices yet.</p>
        )}
        {suggestions.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Current (c)</TableHead>
                <TableHead className="text-right">Avg growth</TableHead>
                <TableHead>Rationale</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suggestions.map((s) => (
                <TableRow key={`${s.category}-${s.name}`}>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{s.category}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{s.currentChaosValue.toFixed(1)}</TableCell>
                  <TableCell className="text-right">{Math.round((s.avgGrowthRatio - 1) * 100)}%</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{s.rationale}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
