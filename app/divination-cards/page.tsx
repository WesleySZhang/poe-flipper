import { AppHeader } from "@/components/app-header";
import { DivinationFlipsPanel } from "@/components/divination-flips-panel";
import { CURRENT_LEAGUE } from "@/lib/league-recency";

export default function DivinationCardsPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader
        title="Divination Card Flips"
        description={
          <>
            Ranks divination cards by profit from buying a full stack and turning it in, in {CURRENT_LEAGUE} - only
            cards with a single, deterministic reward are shown; see the note below the price toggle for why.
          </>
        }
      />
      <DivinationFlipsPanel />
    </div>
  );
}
