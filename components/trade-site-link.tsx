import { ShoppingCart } from "lucide-react";
import { cn } from "cn";

/**
 * Icon link to an official trade site search (lib/trade-site.ts), opened in a new tab. Sits next to
 * an item's name - stopPropagation so it never also triggers a click-to-expand row or card.
 */
export function TradeSiteLink({ href, className }: { href: string; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="Search the trade site"
      aria-label="Search the trade site"
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      <ShoppingCart className={cn("size-3", className)} />
    </a>
  );
}
