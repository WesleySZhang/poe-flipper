import { AppHeader } from "@/components/app-header";
import { DustValuePanel } from "@/components/dust-value-panel";

export default function DustValuePage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader title="Dust Value" />
      <DustValuePanel />
    </div>
  );
}
