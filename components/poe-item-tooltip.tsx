import { cn } from "cn";
import { stripGameMarkup, type ListingMod, type SoldListingItem } from "@/lib/sold-tracker";

/**
 * An item drawn like Path of Exile's own item tooltip (the in-game / trade site box): coloured
 * header with name and base type, sections split by thin rules, grey property labels with white
 * values, blue mods, red "Corrupted", the price note at the bottom. Pure; works for any item the
 * sold listing tracker stored - listings recorded before details were kept fall back to the short
 * mod lists.
 *
 * Dark mode is the game's own look and colours; light mode keeps the layout in black and white, to
 * match the light theme. The palettes are CSS variables on `.poe-tooltip` in app/globals.css; only
 * the dark-mode rarity colour is set per item, here.
 */

// Rarity (name text / header tint) in dark mode - the game's own. Light mode is black and white.
const RARITY_COLOUR: Record<string, string> = {
  Normal: "#c8c8c8",
  Magic: "#8888ff",
  Rare: "#ffff77",
  Unique: "#af6025",
  Gem: "#1ba29b",
  Currency: "#aa9e82",
  "Divination Card": "#0ebaff",
};
const MOD_COLOUR: Record<ListingMod["kind"], string> = {
  enchant: "var(--poe-mod-soft)",
  implicit: "var(--poe-mod)",
  fractured: "var(--poe-fractured)",
  explicit: "var(--poe-mod)",
  crafted: "var(--poe-mod-soft)",
  crucible: "var(--poe-mod)",
  scourge: "var(--poe-mod)",
};
const RARITY = "var(--poe-rarity)";
const LABEL = "var(--poe-label)";
const VALUE = "var(--poe-value)";
const CORRUPTED = "var(--poe-corrupted)";

/** The rarity colour at `percent` opacity - for the header tint, border and rules. */
function rarityMix(percent: number): string {
  return `color-mix(in srgb, var(--poe-rarity) ${percent}%, transparent)`;
}

function formatRanges(ranges: ListingMod["ranges"]): string | undefined {
  if (!ranges?.length) return undefined;
  // A fixed value (min = max) carries no information.
  const shown = ranges.filter((r) => r.min !== r.max);
  if (shown.length === 0) return undefined;
  // "-10 to -5" reads better than "-10–-5".
  return `(${shown.map((r) => (r.min < 0 ? `${r.min} to ${r.max}` : `${r.min}–${r.max}`)).join(", ")})`;
}

function Separator() {
  return <div className="mx-auto my-1.5 h-px w-4/5" style={{ background: `linear-gradient(to right, transparent, ${RARITY}, transparent)` }} />;
}

/** "Limited to: 1" -> grey label, white value. Lines without a colon (templated ones) stay white. */
function PropertyLine({ text: raw }: { text: string }) {
  // Stored before markup was stripped at record time.
  const text = stripGameMarkup(raw);
  const i = text.indexOf(": ");
  if (i === -1) return <div style={{ color: VALUE }}>{text}</div>;
  return (
    <div>
      <span style={{ color: LABEL }}>{text.slice(0, i)}: </span>
      <span style={{ color: VALUE }}>{text.slice(i + 2)}</span>
    </div>
  );
}

export function PoeItemTooltip({
  item,
  price,
  showRanges = false,
  className,
}: {
  item: SoldListingItem;
  /** Shown at the bottom like the item's price note, e.g. "~b/o 100 divine". */
  price?: string;
  /** Each mod's roll range after it, e.g. "60% increased ... (40–60)". */
  showRanges?: boolean;
  className?: string;
}) {
  const rarity = item.rarity ?? "Normal";
  const darkColour = RARITY_COLOUR[rarity] ?? RARITY_COLOUR.Normal;
  const detail = item.detail;
  const twoLineHeader = !!item.name && (rarity === "Unique" || rarity === "Rare");
  const mods: ListingMod[] =
    detail?.mods ??
    [
      ...item.implicits.map((text) => ({ kind: "implicit" as const, text })),
      ...item.mods.map((text) => ({ kind: "explicit" as const, text })),
    ];
  const implicitMods = mods.filter((m) => m.kind === "enchant" || m.kind === "implicit");
  const explicitMods = mods.filter((m) => m.kind !== "enchant" && m.kind !== "implicit");

  const sections: React.ReactNode[] = [];
  const properties = detail?.properties ?? [];
  if (properties.length > 0) sections.push(properties.map((p) => <PropertyLine key={p} text={p} />));
  const requirements = detail?.requirements ?? [];
  if (requirements.length > 0 || detail?.sockets) {
    sections.push(
      <>
        {requirements.length > 0 && (
          <div>
            <span style={{ color: LABEL }}>Requires </span>
            {requirements.map((r, i) => {
              const [label, value] = r.includes(": ") ? r.split(": ") : [r, ""];
              return (
                <span key={r}>
                  {i > 0 && <span style={{ color: LABEL }}>, </span>}
                  <span style={{ color: LABEL }}>{value ? `${label} ` : ""}</span>
                  <span style={{ color: VALUE }}>{value || label}</span>
                </span>
              );
            })}
          </div>
        )}
        {detail?.sockets && <PropertyLine text={`Sockets: ${detail.sockets}`} />}
      </>
    );
  }
  if (item.ilvl !== undefined) sections.push(<PropertyLine text={`Item Level: ${item.ilvl}`} />);
  for (const group of [implicitMods, explicitMods]) {
    if (group.length === 0) continue;
    sections.push(
      group.map((m, i) => {
        const range = showRanges ? formatRanges(m.ranges) : undefined;
        return (
          <div key={i} style={{ color: MOD_COLOUR[m.kind] }}>
            {stripGameMarkup(m.text)}
            {m.kind === "crafted" || m.kind === "fractured" || m.kind === "enchant" ? (
              <span style={{ color: LABEL }}> ({m.kind})</span>
            ) : null}
            {range && <span style={{ color: LABEL }}> {range}</span>}
          </div>
        );
      })
    );
  }
  const statusLines = [
    ...(detail?.tags ?? []).map((t) => ({ text: t, colour: t.startsWith("Foil") || t === "Relic" ? "var(--poe-special)" : VALUE })),
    ...(item.corrupted ? [{ text: "Corrupted", colour: CORRUPTED }] : []),
  ];
  if (statusLines.length > 0) {
    sections.push(statusLines.map((l) => <div key={l.text} style={{ color: l.colour }}>{l.text}</div>));
  }
  if (price) sections.push(<div style={{ color: "var(--poe-price)" }}>{price}</div>);

  return (
    <div
      className={cn("poe-tooltip overflow-hidden rounded-sm border text-center text-[13px] leading-snug", className)}
      style={
        {
          "--poe-rarity-dark": darkColour,
          borderColor: rarityMix(60),
          background: "var(--poe-bg)",
          fontFamily: "var(--font-poe), 'Palatino Linotype', Georgia, serif",
        } as React.CSSProperties
      }
    >
      <div
        className="px-3 py-1 text-[15px]"
        style={{ color: RARITY, background: "var(--poe-header-bg)", borderBottom: `1px solid ${rarityMix(40)}` }}
      >
        {twoLineHeader ? (
          <>
            <div>{item.name}</div>
            <div>{item.typeLine}</div>
          </>
        ) : (
          <div>{item.name ? `${item.name} ${item.typeLine}` : item.typeLine}</div>
        )}
      </div>
      <div className="px-3 py-1.5">
        {sections.map((section, i) => (
          <div key={i}>
            {i > 0 && <Separator />}
            {section}
          </div>
        ))}
      </div>
    </div>
  );
}
