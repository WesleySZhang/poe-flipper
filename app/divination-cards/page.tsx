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
            Buying a full stack of a card and turning it in for its reward, in {CURRENT_LEAGUE} - ranked by how
            much cheaper the stack is than the reward is worth right now. Only cards with a single, deterministic
            reward are shown; see the note below the price toggle for why.
          </>
        }
      />
      <DivinationFlipsPanel />
    </div>
  );
}
