"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { AlertTriangle, Check, Copy, Loader2 } from "lucide-react";
import { cn } from "cn";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MobileSortControl } from "@/components/mobile-sort-control";
import { Pagination } from "@/components/pagination";
import { PoeItemTooltip } from "@/components/poe-item-tooltip";
import { SearchInput } from "@/components/search-input";
import { TradeSiteLink } from "@/components/trade-site-link";
import { sortByKey, toggleSort, type SortState } from "@/lib/sort";
import {
  LISTING_MAX_AGE_DAYS,
  MAX_TRACKED_LISTINGS,
  SOLD_PAGE_DAYS,
  UNSOLD_PAGE_DAYS,
  currentPrice,
  formatSearchTotal,
  listedDurationMs,
  priceSpans,
  type ListingPrice,
  type SoldListingsFile,
  type TrackedListing,
} from "@/lib/sold-tracker";

const PAGE_SIZE = 25;

type SortKey = "ended" | "listed" | "price" | "duration";
// The page file holds listings that ended recently - see buildSoldListingsFile.
type Tab = "sold" | "unsold";

const TAB_LABEL: Record<Tab, string> = { sold: "Sold", unsold: "Unsold" };
const TAB_TITLE: Record<Tab, string> = {
  sold: `Last ${SOLD_PAGE_DAYS} days`,
  unsold: `Still up after ${LISTING_MAX_AGE_DAYS} days; ended in the last ${UNSOLD_PAGE_DAYS} days`,
};
// The end date means something different per tab.
const ENDED_LABEL: Record<Tab, string> = { sold: "Sold", unsold: "Expired" };

async function fetchSoldListings(): Promise<SoldListingsFile | null> {
  const res = await fetch("/api/sold-listings");
  if (!res.ok) return null;
  return res.json();
}

const CURRENCY_SHORT: Record<string, string> = { divine: "d", chaos: "c" };

function formatPrice(p: ListingPrice | undefined): string {
  if (!p) return "—";
  const short = CURRENCY_SHORT[p.currency];
  return short ? `${p.amount}${short}` : `${p.amount} ${p.currency}`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

function endedAt(t: TrackedListing): string {
  return t.endedAt ?? t.lastSeen;
}

function itemName(t: TrackedListing): string {
  return t.item.name ? `${t.item.name} ${t.item.typeLine}` : t.item.typeLine;
}

function matchesSearch(t: TrackedListing, text: string): boolean {
  if (!text) return true;
  return [itemName(t), ...t.searches, ...t.item.implicits, ...t.item.mods].some((s) => s.toLowerCase().includes(text));
}

/** The price as the item's note reads on the trade site, e.g. "~b/o 100 divine". */
function priceNote(t: TrackedListing): string | undefined {
  const p = currentPrice(t);
  return p ? `${p.type ?? "~b/o"} ${p.amount} ${p.currency}` : undefined;
}

/** Every price the listing had, oldest first: earlier ones struck through, each with how long it
 *  stood at that price. The last is the price it sold (or expired) at. */
function PriceTimeline({ t, now }: { t: TrackedListing; now: string }) {
  return (
    <ul className="flex flex-col">
      {priceSpans(t, now).map((s) => (
        <li key={s.price.at} className="flex items-baseline justify-between gap-3" title={`From ${formatDate(s.price.at)}`}>
          <span className={cn(s.current ? "text-base font-semibold" : "text-sm text-muted-foreground line-through")}>
            {formatPrice(s.price)}
          </span>
          <span className="text-xs text-muted-foreground">{formatDuration(s.durationMs)}</span>
        </li>
      ))}
    </ul>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function SearchLinks({ t, searchLinks }: { t: TrackedListing; searchLinks: Map<string, string> }) {
  return (
    <>
      {t.searches.map((label) => (
        <span key={label} className="inline-flex items-center gap-1">
          {label}
          {searchLinks.get(label) && <TradeSiteLink href={searchLinks.get(label)!} className="size-3.5" />}
        </span>
      ))}
    </>
  );
}

/** The listing's own facts, stacked: price history, then listed / sold / time up / search. */
function ListingFacts({ t, now, searchLinks }: { t: TrackedListing; now: string; searchLinks: Map<string, string> }) {
  const tab: Tab = t.status === "unsold" ? "unsold" : "sold";
  return (
    <div className="flex flex-col gap-2">
      <div>
        <span className="text-xs text-muted-foreground">Price · time at price</span>
        <PriceTimeline t={t} now={now} />
      </div>
      <div className="flex flex-col gap-0.5 border-t border-border pt-2">
        <Field label="Listed">{formatDate(t.listedAt)}</Field>
        <Field label={ENDED_LABEL[tab]}>{formatDate(endedAt(t))}</Field>
        <Field label="Time up">{formatDuration(listedDurationMs(t, now))}</Field>
        <Field label="Search">
          <SearchLinks t={t} searchLinks={searchLinks} />
        </Field>
      </div>
      {t.reappeared && (
        <Badge variant="outline" className="self-start" title="Counted sold once, then listed again">
          Relisted
        </Badge>
      )}
    </div>
  );
}

/** Everything recorded about one listing: the full item with roll ranges, and its listing history. */
function ListingDetailDialog({
  t,
  onClose,
  searchLinks,
  loadedAt,
}: {
  t: TrackedListing | null;
  onClose: () => void;
  searchLinks: Map<string, string>;
  loadedAt: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = t?.item.detail?.text;
  return (
    <Dialog open={t !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        {t && (
          <>
            <DialogTitle className="sr-only">{itemName(t)}</DialogTitle>
            <PoeItemTooltip item={t.item} price={priceNote(t)} showRanges className="mt-6" />
            <ListingFacts t={t} now={loadedAt} searchLinks={searchLinks} />
            {text && (
              <Button
                variant="outline"
                size="sm"
                className="justify-self-start"
                onClick={() => {
                  void navigator.clipboard.writeText(text).then(() => setCopied(true));
                }}
                onBlur={() => setCopied(false)}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy item text"}
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Listings the sold listing tracker followed, by what happened to them - see lib/sold-tracker.ts for
 * how a sale is decided and scripts/track-sold-listings.ts for the tracker itself. One row per item:
 * the item drawn like the game's tooltip, and its listing facts stacked beside it (under it on a
 * phone). Clicking a row opens the item with its roll ranges.
 */
export function SoldListingsPanel() {
  const [file, setFile] = useState<SoldListingsFile | null>(null);
  const [tab, setTab] = useState<Tab>("sold");
  const [searchText, setSearchText] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "ended", direction: "desc" });
  const [isPending, startTransition] = useTransition();
  // The listing whose details are open.
  const [selected, setSelected] = useState<TrackedListing | null>(null);
  // Durations count up to "now" for anything still open; fixed per load so renders stay pure.
  const [loadedAt, setLoadedAt] = useState(() => new Date(0).toISOString());

  useEffect(() => {
    startTransition(async () => {
      setFile(await fetchSoldListings());
      setLoadedAt(new Date().toISOString());
      setPage(0);
    });
  }, []);

  const listings = useMemo(() => file?.listings ?? [], [file]);
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { sold: 0, unsold: 0 };
    for (const t of listings) if (t.status === "sold" || t.status === "unsold") c[t.status]++;
    return c;
  }, [listings]);

  const normalizedSearch = searchText.trim().toLowerCase();
  const visible = useMemo(
    () =>
      sortByKey(
        listings.filter((t) => t.status === tab && matchesSearch(t, normalizedSearch)),
        sort,
        (t, key) => {
          switch (key) {
            case "ended":
              return Date.parse(endedAt(t));
            case "listed":
              return Date.parse(t.listedAt);
            case "price": {
              // Divine-priced listings first by amount; anything else sorts after them.
              const p = currentPrice(t);
              return p?.currency === "divine" ? p.amount : undefined;
            }
            case "duration":
              return listedDurationMs(t, loadedAt);
          }
        }
      ),
    [listings, tab, normalizedSearch, sort, loadedAt]
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageStart = Math.min(page, pageCount - 1) * PAGE_SIZE;
  const paged = visible.slice(pageStart, pageStart + PAGE_SIZE);

  function changeTab(value: Tab) {
    setTab(value);
    setPage(0);
  }

  function changeSearchText(text: string) {
    setSearchText(text);
    setPage(0);
  }

  function openOnKey(e: React.KeyboardEvent, t: TrackedListing) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelected(t);
    }
  }

  function handleSort(key: SortKey) {
    setSort((prev) => toggleSort(prev, key));
    setPage(0);
  }

  const searchLinks = new Map((file?.searches ?? []).map((s) => [s.label, s.url]));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <CardTitle className="flex items-center gap-2">
          Sold Listings
          {isPending && (
            <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading...
            </span>
          )}
        </CardTitle>
        <div className="flex flex-col gap-1.5">
          <Label>Show</Label>
          <Tabs value={tab} onValueChange={(value) => changeTab(value as Tab)}>
            <TabsList>
              {(["sold", "unsold"] as const).map((s) => (
                <TabsTrigger key={s} value={s} title={TAB_TITLE[s]}>
                  {TAB_LABEL[s]} {counts[s]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {file && (
          <div className="flex flex-col gap-2">
            <p
              className="text-xs text-muted-foreground"
              title={`Instant buyout, listed in the last week. Sold = no longer listed. Unsold = still up after ${LISTING_MAX_AGE_DAYS} days. A seller pulling an item looks like a sale.`}
            >
              Tracking {file.trackedCount.toLocaleString("en-US")} listings · instant buyout · updated {formatDate(file.updatedAt)}
            </p>
            {file.atCapacity && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="size-3.5 shrink-0" />
                Tracking limit ({MAX_TRACKED_LISTINGS}) reached - new listings skipped
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {file.searches.map((s) => (
                <span
                  key={s.label}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
                  title={s.error ?? s.paused ?? (s.lastRun ? `Last run ${formatDate(s.lastRun)}` : "Not run yet")}
                >
                  {s.label}
                  {s.total !== undefined && <span className="text-muted-foreground">· {formatSearchTotal(s.total)} listed</span>}
                  {s.paused && <span className="text-destructive">· paused</span>}
                  {(s.error || s.missedListings) && (
                    <AlertTriangle className="size-3.5 text-destructive" aria-label={s.error ? "Search failed" : "Missed listings"} />
                  )}
                  <TradeSiteLink href={s.url} className="size-3.5" />
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchInput value={searchText} onChange={changeSearchText} placeholder="Search items or mods..." />
          {!isPending && file && listings.length > 0 && (
            <MobileSortControl
              allWidths
              options={[
                { key: "ended", label: ENDED_LABEL[tab] },
                { key: "listed", label: "Listed" },
                { key: "price", label: "Price" },
                { key: "duration", label: "Time up" },
              ]}
              sort={sort}
              onSort={handleSort}
            />
          )}
        </div>
        {isPending && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">Loading listings...</p>
          </div>
        )}
        {!isPending && !file && <p className="text-sm text-muted-foreground">No tracker data yet.</p>}
        {!isPending && file && (
          // -mx-4 on phones cancels CardContent's own px-4, same as the other panels' card lists.
          <div className="-mx-4 flex flex-col gap-2 sm:mx-0">
            {paged.map((t) => (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(t)}
                onKeyDown={(e) => openOnKey(e, t)}
                className="grid cursor-pointer grid-cols-1 gap-3 rounded-lg border border-border p-2 hover:bg-muted/40 active:bg-muted/50 sm:grid-cols-[minmax(0,1fr)_15rem] sm:p-3"
              >
                <PoeItemTooltip item={t.item} price={priceNote(t)} />
                <ListingFacts t={t} now={loadedAt} searchLinks={searchLinks} />
              </div>
            ))}
          </div>
        )}
        {!isPending && file && visible.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {listings.length === 0 ? "No listings tracked yet." : `No ${TAB_LABEL[tab].toLowerCase()} listings match.`}
          </p>
        )}
        <Pagination page={Math.min(page, pageCount - 1)} pageCount={pageCount} totalRows={visible.length} onPageChange={setPage} />
        <ListingDetailDialog t={selected} onClose={() => setSelected(null)} searchLinks={searchLinks} loadedAt={loadedAt} />
      </CardContent>
    </Card>
  );
}
