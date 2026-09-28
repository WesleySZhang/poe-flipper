"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "cn";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MobileSortControl } from "@/components/mobile-sort-control";
import { Pagination } from "@/components/pagination";
import { SearchInput } from "@/components/search-input";
import { SortableHeader } from "@/components/sortable-header";
import { TradeSiteLink } from "@/components/trade-site-link";
import { sortByKey, toggleSort, type SortState } from "@/lib/sort";
import {
  LISTING_MAX_AGE_DAYS,
  MAX_TRACKED_LISTINGS,
  SOLD_AFTER_MISSING_HOURS,
  currentPrice,
  formatSearchTotal,
  listedDurationMs,
  type ListingPrice,
  type ListingStatus,
  type SoldTrackerFile,
  type TrackedListing,
} from "@/lib/sold-tracker";

const PAGE_SIZE = 25;

type SortKey = "ended" | "listed" | "price" | "duration";

const STATUS_LABEL: Record<ListingStatus, string> = { sold: "Sold", unsold: "Unsold", listed: "Listed" };
// The date column means something different per tab.
const ENDED_LABEL: Record<ListingStatus, string> = { sold: "Sold", unsold: "Expired", listed: "Last seen" };

async function fetchSoldListings(): Promise<SoldTrackerFile | null> {
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

/** "100d → 50d" when the price changed, else just the price. */
function formatPriceHistory(t: TrackedListing): string {
  if (t.prices.length <= 1) return formatPrice(currentPrice(t));
  const first = t.prices[0];
  return `${formatPrice(first)} → ${formatPrice(currentPrice(t))}`;
}

function priceTitle(t: TrackedListing): string {
  return t.prices.map((p) => `${formatPrice(p)} from ${formatDate(p.at)}`).join("\n");
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

/** Item name, base, and every mod - the part of a listing that says what sold. */
function ItemSummary({ t, className }: { t: TrackedListing; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="font-medium">{t.item.name || t.item.typeLine}</span>
        {t.item.name && <span className="text-xs text-muted-foreground">{t.item.typeLine}</span>}
        {t.item.corrupted && <span className="text-xs text-destructive">Corrupted</span>}
        {t.missingSince && t.status === "listed" && (
          <Badge variant="outline" title={`Not listed since ${formatDate(t.missingSince)}. Counted sold after ${SOLD_AFTER_MISSING_HOURS}h gone.`}>
            Gone
          </Badge>
        )}
        {t.reappeared && (
          <Badge variant="outline" title="Counted sold once, then listed again">
            Relisted
          </Badge>
        )}
      </div>
      <ul className="text-xs leading-snug text-muted-foreground">
        {t.item.implicits.map((m, i) => (
          <li key={`i${i}`} className="italic">
            {m}
          </li>
        ))}
        {t.item.mods.map((m, i) => (
          <li key={`m${i}`}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Listings the sold listing tracker followed, by what happened to them - see lib/sold-tracker.ts for
 * how a sale is decided and scripts/track-sold-listings.ts for the tracker itself.
 */
export function SoldListingsPanel() {
  const [file, setFile] = useState<SoldTrackerFile | null>(null);
  const [status, setStatus] = useState<ListingStatus>("sold");
  const [searchText, setSearchText] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "ended", direction: "desc" });
  const [isPending, startTransition] = useTransition();
  // Durations of still-listed items count up to "now"; fixed per load so renders stay pure.
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
    const c: Record<ListingStatus, number> = { sold: 0, unsold: 0, listed: 0 };
    for (const t of listings) c[t.status]++;
    return c;
  }, [listings]);

  const normalizedSearch = searchText.trim().toLowerCase();
  const visible = useMemo(
    () =>
      sortByKey(
        listings.filter((t) => t.status === status && matchesSearch(t, normalizedSearch)),
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
    [listings, status, normalizedSearch, sort, loadedAt]
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageStart = Math.min(page, pageCount - 1) * PAGE_SIZE;
  const paged = visible.slice(pageStart, pageStart + PAGE_SIZE);
  const endedLabel = ENDED_LABEL[status];

  function changeStatus(value: ListingStatus) {
    setStatus(value);
    setPage(0);
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
          <Tabs value={status} onValueChange={(value) => changeStatus(value as ListingStatus)}>
            <TabsList>
              {(["sold", "unsold", "listed"] as const).map((s) => (
                <TabsTrigger key={s} value={s}>
                  {STATUS_LABEL[s]} {counts[s]}
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
              title={`Instant buyout, listed in the last week. Sold = gone ${SOLD_AFTER_MISSING_HOURS}h+. Unsold = still up after ${LISTING_MAX_AGE_DAYS} days. A seller pulling an item looks like a sale.`}
            >
              Instant buyout · updated {formatDate(file.updatedAt)}
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
                    <AlertTriangle
                      className="size-3.5 text-destructive"
                      aria-label={s.error ? "Search failed" : "Missed listings"}
                    />
                  )}
                  <TradeSiteLink href={s.url} className="size-3.5" />
                </span>
              ))}
            </div>
          </div>
        )}
        <SearchInput value={searchText} onChange={changeSearchText} placeholder="Search items or mods..." />
        {isPending && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">Loading listings...</p>
          </div>
        )}
        {!isPending && !file && <p className="text-sm text-muted-foreground">No tracker data yet.</p>}
        {!isPending && file && listings.length > 0 && (
          <MobileSortControl
            options={[
              { key: "ended", label: endedLabel },
              { key: "listed", label: "Listed" },
              { key: "price", label: "Price" },
              { key: "duration", label: "Time up" },
            ]}
            sort={sort}
            onSort={handleSort}
          />
        )}
        {!isPending && file && (
          // -mx-4 cancels CardContent's own px-4, same as the other panels' mobile card lists.
          <div className="-mx-4 flex flex-col gap-2 sm:hidden">
            {paged.map((t) => (
              <div key={t.id} className="flex flex-col gap-2 rounded-lg border border-border p-2">
                <ItemSummary t={t} className="text-sm" />
                <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1.5">
                  {[
                    { label: "Listed", value: formatDate(t.listedAt) },
                    { label: endedLabel, value: formatDate(endedAt(t)) },
                    { label: "Time up", value: formatDuration(listedDurationMs(t, loadedAt)) },
                  ].map((f) => (
                    <div key={f.label} className="flex flex-col">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{f.label}</span>
                      <span className="text-xs text-muted-foreground">{f.value}</span>
                    </div>
                  ))}
                  <div className="ml-auto flex flex-col items-end">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Price</span>
                    <span className="text-sm font-bold" title={priceTitle(t)}>
                      {formatPriceHistory(t)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {!isPending && file && listings.length > 0 && (
          <Table className="hidden sm:table">
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <SortableHeader label="Price" sortKey="price" sort={sort} onSort={handleSort} />
                <SortableHeader label="Listed" sortKey="listed" sort={sort} onSort={handleSort} />
                <SortableHeader label={endedLabel} sortKey="ended" sort={sort} onSort={handleSort} />
                <SortableHeader label="Time up" sortKey="duration" sort={sort} onSort={handleSort} />
                <TableHead>Search</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((t) => (
                <TableRow key={t.id} className="align-top">
                  <TableCell className="max-w-[360px] whitespace-normal">
                    <ItemSummary t={t} />
                  </TableCell>
                  <TableCell className="text-right font-medium" title={priceTitle(t)}>
                    {formatPriceHistory(t)}
                  </TableCell>
                  <TableCell className="text-right">{formatDate(t.listedAt)}</TableCell>
                  <TableCell className="text-right">{formatDate(endedAt(t))}</TableCell>
                  <TableCell className="text-right">{formatDuration(listedDurationMs(t, loadedAt))}</TableCell>
                  <TableCell className="whitespace-normal text-xs text-muted-foreground">
                    {t.searches.map((label) => (
                      <span key={label} className="flex items-center gap-1">
                        {label}
                        {searchLinks.get(label) && <TradeSiteLink href={searchLinks.get(label)!} className="size-3" />}
                      </span>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!isPending && file && visible.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {listings.length === 0 ? "No listings tracked yet." : `No ${STATUS_LABEL[status].toLowerCase()} listings match.`}
          </p>
        )}
        <Pagination page={Math.min(page, pageCount - 1)} pageCount={pageCount} totalRows={visible.length} onPageChange={setPage} />
      </CardContent>
    </Card>
  );
}
