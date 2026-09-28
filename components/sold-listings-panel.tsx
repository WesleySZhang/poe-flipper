"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "cn";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
// The page file holds recently ended listings and those still up - see buildSoldListingsFile.
type Tab = "sold" | "unsold";

const TAB_LABEL: Record<Tab, string> = { sold: "Sold", unsold: "Unsold" };
const TAB_TITLE: Record<Tab, string> = {
  sold: `Last ${SOLD_PAGE_DAYS} days`,
  unsold: `Still listed, or expired (up ${LISTING_MAX_AGE_DAYS} days) in the last ${UNSOLD_PAGE_DAYS} days`,
};
// The end date's sort label per tab; on Unsold it's the expiry, or the last check for one still up.
const ENDED_LABEL: Record<Tab, string> = { sold: "Sold", unsold: "Last seen" };

// Listings still up count as unsold.
function tabOf(t: TrackedListing): Tab {
  return t.status === "sold" ? "sold" : "unsold";
}

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
  const endedLabel = t.status === "sold" ? "Sold" : t.status === "unsold" ? "Expired" : "Last seen";
  return (
    <div className="flex flex-col gap-2">
      <div>
        <span className="text-xs text-muted-foreground">Price · time at price</span>
        <PriceTimeline t={t} now={now} />
      </div>
      <div className="flex flex-col gap-0.5 border-t border-border pt-2">
        <Field label="Listed">{formatDate(t.listedAt)}</Field>
        <Field label={endedLabel}>{formatDate(endedAt(t))}</Field>
        <Field label="Time up">{formatDuration(listedDurationMs(t, now))}</Field>
        <Field label="Search">
          <SearchLinks t={t} searchLinks={searchLinks} />
        </Field>
      </div>
      {(t.status === "listed" || t.reappeared) && (
        <div className="flex gap-1.5">
          {t.status === "listed" && (
            <Badge variant="secondary" title="Not sold yet; still on the trade site at the last check">
              Still listed
            </Badge>
          )}
          {t.reappeared && (
            <Badge variant="outline" title="Counted sold once, then listed again">
              Relisted
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Listings the sold listing tracker followed, by what happened to them - see lib/sold-tracker.ts for
 * how a sale is decided and scripts/track-sold-listings.ts for the tracker itself. One row per item:
 * the item drawn like the game's tooltip, and its listing facts stacked beside it (under it on a
 * phone).
 */
export function SoldListingsPanel() {
  const [file, setFile] = useState<SoldListingsFile | null>(null);
  const [tab, setTab] = useState<Tab>("sold");
  const [searchText, setSearchText] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "price", direction: "asc" });
  const [isPending, startTransition] = useTransition();
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
    for (const t of listings) c[tabOf(t)]++;
    return c;
  }, [listings]);

  // Searches picked as filters at the top; empty = every search.
  const [pickedSearches, setPickedSearches] = useState<Set<string>>(() => new Set());
  const tabListings = useMemo(() => listings.filter((t) => tabOf(t) === tab), [listings, tab]);
  // How many of this tab's listings each search found.
  const searchCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const t of tabListings) for (const label of t.searches) c.set(label, (c.get(label) ?? 0) + 1);
    return c;
  }, [tabListings]);

  const normalizedSearch = searchText.trim().toLowerCase();
  const visible = useMemo(
    () =>
      sortByKey(
        tabListings.filter(
          (t) => (pickedSearches.size === 0 || t.searches.some((l) => pickedSearches.has(l))) && matchesSearch(t, normalizedSearch)
        ),
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
    [tabListings, pickedSearches, normalizedSearch, sort, loadedAt]
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageStart = Math.min(page, pageCount - 1) * PAGE_SIZE;
  const paged = visible.slice(pageStart, pageStart + PAGE_SIZE);

  function changeTab(value: Tab) {
    setTab(value);
    setPage(0);
  }

  function changePickedSearches(next: Set<string>) {
    setPickedSearches(next);
    setPage(0);
  }

  function toggleSearch(label: string) {
    const next = new Set(pickedSearches);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    changePickedSearches(next);
  }

  function changeSearchText(text: string) {
    setSearchText(text);
    setPage(0);
  }

  function handleSort(key: SortKey) {
    setSort((prev) => toggleSort(prev, key));
    setPage(0);
  }

  const searchLinks = new Map((file?.searches ?? []).map((s) => [s.label, s.url]));

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        {/* Searches (as filters: none picked = all) on the left, Sold/Unsold on the right. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {file && file.searches.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-pressed={pickedSearches.size === 0}
                onClick={() => changePickedSearches(new Set())}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm",
                  pickedSearches.size === 0 ? "border-primary bg-primary text-primary-foreground" : "border-border"
                )}
              >
                All <span className="opacity-70">{tabListings.length}</span>
              </button>
              {file.searches.map((s) => {
                const on = pickedSearches.has(s.label);
                return (
                  <div
                    key={s.label}
                    className={cn(
                      "flex items-center rounded-md border text-sm",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-border"
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleSearch(s.label)}
                      title={
                        s.error ??
                        s.paused ??
                        `${s.total !== undefined ? `${formatSearchTotal(s.total)} listed now. ` : ""}${s.lastRun ? `Last run ${formatDate(s.lastRun)}` : "Not run yet"}`
                      }
                      className="flex h-8 items-center gap-1.5 pl-2.5 pr-1"
                    >
                      {s.label}
                      <span className="opacity-70">{searchCounts.get(s.label) ?? 0}</span>
                      {s.paused && <span className={on ? "" : "text-destructive"}>· paused</span>}
                      {(s.error || s.missedListings) && (
                        <AlertTriangle className="size-3.5" aria-label={s.error ? "Search failed" : "Missed listings"} />
                      )}
                    </button>
                    <TradeSiteLink href={s.url} className="mr-2 size-3.5" />
                  </div>
                );
              })}
            </div>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            {isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />}
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
        </div>
        {file && (
          <div className="flex flex-col gap-2">
            <p
              className="text-xs text-muted-foreground"
              title={`Instant buyout, listed in the last week. Sold = no longer listed. Unsold = still listed, or expired after ${LISTING_MAX_AGE_DAYS} days. A seller pulling an item looks like a sale.`}
            >
              Tracking {file.trackedCount.toLocaleString("en-US")} / {MAX_TRACKED_LISTINGS.toLocaleString("en-US")} listings · instant buyout · updated {formatDate(file.updatedAt)}
            </p>
            {file.atCapacity && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="size-3.5 shrink-0" />
                Tracking limit ({MAX_TRACKED_LISTINGS}) reached - new listings skipped
              </p>
            )}
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
                className="grid grid-cols-1 gap-3 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,1fr)_15rem] sm:p-3"
              >
                <PoeItemTooltip item={t.item} price={priceNote(t)} showRanges />
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
      </CardContent>
    </Card>
  );
}
