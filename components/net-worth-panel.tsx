"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { refreshNetWorth, getNetWorthHistory, type NetWorthSnapshotPoint } from "@/app/actions/networth";
import type { NetWorthResult } from "@/lib/networth";
import type { SessionState } from "@/app/actions/login";
import { toast } from "sonner";

const chartConfig = {
  totalChaos: { label: "Chaos value", color: "var(--chart-1)" },
};

export function NetWorthPanel({ session }: { session: SessionState }) {
  const [result, setResult] = useState<NetWorthResult | null>(null);
  const [history, setHistory] = useState<NetWorthSnapshotPoint[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!session.loggedIn) return;
    startTransition(async () => {
      const points = await getNetWorthHistory();
      setHistory(points);
    });
  }, [session.loggedIn]);

  function handleRefresh() {
    startTransition(async () => {
      const response = await refreshNetWorth();
      if (response.ok) {
        setResult(response.result);
        setHistory(await getNetWorthHistory());
        toast.success("Net worth refreshed");
      } else {
        toast.error(response.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Net worth</CardTitle>
          <CardDescription>Priced from live poe.ninja values</CardDescription>
        </div>
        <Button onClick={handleRefresh} disabled={!session.loggedIn || isPending}>
          {isPending ? "Refreshing..." : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!session.loggedIn && (
          <p className="text-sm text-muted-foreground">Connect your account above to see your net worth.</p>
        )}

        {result && (
          <div className="flex gap-6">
            <div>
              <p className="text-sm text-muted-foreground">Total (chaos)</p>
              <p className="text-2xl font-semibold">{result.totalChaos.toFixed(0)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total (divine)</p>
              <p className="text-2xl font-semibold">{result.totalDivine.toFixed(2)}</p>
            </div>
          </div>
        )}

        {history.length > 1 && (
          <ChartContainer config={chartConfig} className="h-48 w-full">
            <LineChart data={history}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="snapshotAt" hide />
              <YAxis hide />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Line
                type="monotone"
                dataKey="totalChaos"
                stroke="var(--color-totalChaos)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        )}

        {result && result.breakdown.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit (c)</TableHead>
                <TableHead className="text-right">Total (c)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.breakdown.slice(0, 20).map((entry) => (
                <TableRow key={entry.name}>
                  <TableCell>{entry.name}</TableCell>
                  <TableCell className="text-right">{entry.quantity}</TableCell>
                  <TableCell className="text-right">{entry.unitChaosValue.toFixed(1)}</TableCell>
                  <TableCell className="text-right">{entry.totalChaosValue.toFixed(0)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {isPending && !result && <Skeleton className="h-24 w-full" />}
      </CardContent>
    </Card>
  );
}
