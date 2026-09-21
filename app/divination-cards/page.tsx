import { AppHeader } from "@/components/app-header";
import { DivinationFlipsPanel } from "@/components/divination-flips-panel";

export default function DivinationCardsPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader title="Divination Card Flips" />
      <DivinationFlipsPanel />
    </div>
  );
}
