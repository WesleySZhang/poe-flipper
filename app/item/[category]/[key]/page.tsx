import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { ItemDetailPanel } from "@/components/item-detail-panel";
import { parseItemPriceKey, formatItemDisplayName } from "@/lib/poe-ninja";

// Next.js 16 passes dynamic route params as a Promise (confirmed against
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md - no
// other dynamic route existed in this app to copy the convention from). Verified live: `key`
// arrives here STILL percent-encoded (e.g. "Orb%20of%20Intention"), so it needs its own
// decodeURIComponent before parseItemPriceKey can split it back into name/variant.
export default async function ItemDetailPage({ params }: { params: Promise<{ category: string; key: string }> }) {
  const { category, key } = await params;
  if (category !== "currency" && category !== "item") notFound();

  const { name, variant } = parseItemPriceKey(decodeURIComponent(key));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-2 sm:p-6">
      <AppHeader title={formatItemDisplayName(name, variant)} />
      <ItemDetailPanel category={category} historyName={name} variant={variant} />
    </div>
  );
}
