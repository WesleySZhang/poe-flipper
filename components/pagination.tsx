"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Simple prev/next pager over an already-fetched, already-filtered array of rows. */
export function Pagination({
  page,
  pageCount,
  totalRows,
  onPageChange,
}: {
  /** 0-indexed current page. */
  page: number;
  pageCount: number;
  totalRows: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-sm text-muted-foreground">{totalRows} rows</p>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft /> Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          Page {page + 1} of {pageCount}
        </span>
        <Button variant="outline" size="sm" disabled={page >= pageCount - 1} onClick={() => onPageChange(page + 1)}>
          Next <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
