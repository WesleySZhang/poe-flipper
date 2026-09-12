"use client";

import { useState } from "react";
import { LoginCard } from "@/components/login-card";
import { NetWorthPanel } from "@/components/net-worth-panel";
import { FlipSuggestionsPanel } from "@/components/flip-suggestions-panel";
import type { SessionState } from "@/app/actions/login";

export function Dashboard({ initialSession }: { initialSession: SessionState }) {
  const [session, setSession] = useState<SessionState>(initialSession);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">PoE Trade Assistant</h1>
        <p className="text-sm text-muted-foreground">
          Unofficial tool - not affiliated with or endorsed by Grinding Gear Games.
        </p>
      </header>

      <LoginCard session={session} onSessionChange={setSession} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <NetWorthPanel key={`networth-${session.accountName ?? "guest"}`} session={session} />
        <FlipSuggestionsPanel key={`flip-${session.accountName ?? "guest"}`} session={session} />
      </div>
    </div>
  );
}
