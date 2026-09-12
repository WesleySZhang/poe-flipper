"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { login, logout, type SessionState } from "@/app/actions/login";
import { toast } from "sonner";

export function LoginCard({
  session,
  onSessionChange,
}: {
  session: SessionState;
  onSessionChange: (session: SessionState) => void;
}) {
  const [accountName, setAccountName] = useState("");
  const [poesessid, setPoesessid] = useState("");
  const [league, setLeague] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await login({ accountName, poesessid, league });
      if (result.ok) {
        onSessionChange({ loggedIn: true, accountName, league });
        setPoesessid("");
        toast.success("Connected");
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleLogout() {
    startTransition(async () => {
      await logout();
      onSessionChange({ loggedIn: false });
      toast.success("Disconnected");
    });
  }

  if (session.loggedIn) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Connected</CardTitle>
            <CardDescription>
              {session.accountName} &middot; {session.league}
            </CardDescription>
          </div>
          <Button variant="outline" onClick={handleLogout} disabled={isPending}>
            Disconnect
          </Button>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect your account</CardTitle>
        <CardDescription>
          Your POESESSID is kept only in an encrypted session cookie, never written to disk. Use your own account
          only - this uses the unofficial legacy stash API (grey-area vs. GGG&apos;s ToS).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="accountName">Account name</Label>
            <Input
              id="accountName"
              placeholder="YourName#1234"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="poesessid">POESESSID</Label>
            <Input
              id="poesessid"
              type="password"
              autoComplete="off"
              value={poesessid}
              onChange={(e) => setPoesessid(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="league">League</Label>
            <Input
              id="league"
              placeholder="Settlers"
              value={league}
              onChange={(e) => setLeague(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Connecting..." : "Connect"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
