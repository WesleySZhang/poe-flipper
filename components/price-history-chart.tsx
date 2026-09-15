"use client";

import { useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { allKnownLeagues, CURRENT_LEAGUE } from "@/lib/league-recency";
import { activePrice, priceUnitLabel, type PriceUnit } from "@/lib/price-unit";
import type { LeagueSeries } from "@/lib/price-history";

export type PriceHistoryFetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; series: LeagueSeries[] };

// Fixed logical coordinate space - the <svg> scales to its container via CSS (preserveAspectRatio
// "none" + a w-full/h-* wrapper), so none of this math needs to know the actual rendered pixel size.
const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 240;
const MARGIN = { top: 12, right: 16, bottom: 24, left: 44 };
const PLOT_WIDTH = VIEW_WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = VIEW_HEIGHT - MARGIN.top - MARGIN.bottom;

const CHART_COLOR_VARS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
// Stable per-league color assignment - an index into whichever subset of leagues happen to have
// data for one particular item would shift colors inconsistently between different items' charts
// whenever a league is missing a name. allKnownLeagues() always lists the same leagues in the same
// order, so filtering out the live current league (which never has history to plot anyway - see
// lib/price-history.ts's header) gives a fixed, reusable name->color mapping.
const COLOR_LEAGUES = allKnownLeagues().filter((league) => league !== CURRENT_LEAGUE);
function leagueColor(league: string): string {
  const idx = COLOR_LEAGUES.indexOf(league);
  return CHART_COLOR_VARS[idx >= 0 ? idx % CHART_COLOR_VARS.length : 0];
}

function formatTick(value: number, unit: PriceUnit): string {
  const decimals = value < 1 ? (value < 0.01 ? 4 : 3) : value < 10 ? 2 : 1;
  return `${value.toFixed(decimals)}${priceUnitLabel(unit) === "div" ? "d" : "c"}`;
}

interface PlottedPoint {
  dayOffset: number;
  value: number;
}

interface PlottedSeries {
  league: string;
  color: string;
  points: PlottedPoint[];
}

/**
 * Per-item price history, one line per past league, with a vertical marker for the current day of
 * the league being predicted from. See lib/price-history.ts for why the live current league itself
 * never has a line here - only past, fully-ingested leagues do.
 */
export function PriceHistoryChart({
  state,
  currentDay,
  priceUnit,
}: {
  state: PriceHistoryFetchState;
  currentDay: number;
  priceUnit: PriceUnit;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverDay, setHoverDay] = useState<number | undefined>();

  const plotted: PlottedSeries[] = useMemo(() => {
    if (state.status !== "loaded") return [];
    return state.series
      .map((s) => ({
        league: s.league,
        color: leagueColor(s.league),
        points: s.points
          .map((p) => ({ dayOffset: p.dayOffset, value: activePrice(p.chaosValue, p.divineValue, priceUnit) }))
          // Skip points with no value in the active unit (e.g. divine mode with no rate that day)
          // rather than drawing a false zero.
          .filter((p): p is PlottedPoint => p.value !== undefined && p.value > 0),
      }))
      .filter((s) => s.points.length > 0);
  }, [state, priceUnit]);

  const allValues = plotted.flatMap((s) => s.points.map((p) => p.value));
  const allDays = plotted.flatMap((s) => s.points.map((p) => p.dayOffset));

  if (state.status === "loading") {
    return (
      <div className="flex h-56 items-center justify-center gap-2 text-sm text-muted-foreground sm:h-64">
        <Loader2 className="size-4 animate-spin" />
        Loading price history...
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-muted-foreground sm:h-64">
        Couldn&apos;t load price history.
      </div>
    );
  }

  if (plotted.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-muted-foreground sm:h-64">
        {priceUnit === "divine"
          ? "No historical price data for this item in Divine terms - try Chaos mode."
          : "No historical price data for this item."}
      </div>
    );
  }

  // Log scale for Y - this app reasons about currency growth in log space throughout (see
  // lib/growth-ratios.ts) since a linear scale would let one expensive tail dominate and make an
  // early cheap price invisible next to a late expensive one.
  let logMin = Math.log(Math.min(...allValues));
  let logMax = Math.log(Math.max(...allValues));
  if (logMin === logMax) {
    // Flat or single-point data - pad the domain so the line isn't drawn on a degenerate 0-height
    // scale (divide-by-zero guard).
    logMin -= 0.5;
    logMax += 0.5;
  }
  const dayMin = Math.min(0, ...allDays, currentDay);
  const dayMax = Math.max(...allDays, currentDay);
  const dayRange = dayMax - dayMin || 1;

  const xScale = (day: number) => MARGIN.left + ((day - dayMin) / dayRange) * PLOT_WIDTH;
  const yScale = (value: number) => MARGIN.top + (1 - (Math.log(value) - logMin) / (logMax - logMin)) * PLOT_HEIGHT;

  const yTicks = [0, 1 / 3, 2 / 3, 1].map((f) => Math.exp(logMin + f * (logMax - logMin)));

  function handlePointerMove(e: React.PointerEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    const viewX = fraction * VIEW_WIDTH;
    const day = Math.round(dayMin + ((viewX - MARGIN.left) / PLOT_WIDTH) * dayRange);
    setHoverDay(Math.min(dayMax, Math.max(dayMin, day)));
  }

  // Nearest point per league to the hovered day, for the tooltip - not necessarily an exact day
  // match, since not every league has a recorded value on every single day.
  const hoverRows =
    hoverDay === undefined
      ? []
      : plotted
          .map((s) => {
            const nearest = s.points.reduce((best, p) =>
              Math.abs(p.dayOffset - hoverDay) < Math.abs(best.dayOffset - hoverDay) ? p : best
            );
            return { league: s.league, color: s.color, point: nearest };
          })
          // Ignore a "nearest" point that's actually far away - a league whose tracking doesn't
          // reach anywhere near the hovered day shouldn't show a misleading value.
          .filter(({ point }) => Math.abs(point.dayOffset - hoverDay) <= 5);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-56 w-full sm:h-64">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-full w-full overflow-visible"
        >
          {/* Y-axis gridlines + labels */}
          {yTicks.map((value, i) => (
            <g key={i}>
              <line
                x1={MARGIN.left}
                x2={VIEW_WIDTH - MARGIN.right}
                y1={yScale(value)}
                y2={yScale(value)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text x={MARGIN.left - 6} y={yScale(value)} textAnchor="end" dominantBaseline="middle" fontSize={9} fill="var(--muted-foreground)">
                {formatTick(value, priceUnit)}
              </text>
            </g>
          ))}

          {/* X-axis min/max day labels */}
          <text x={MARGIN.left} y={VIEW_HEIGHT - 6} textAnchor="start" fontSize={9} fill="var(--muted-foreground)">
            Day {Math.round(dayMin)}
          </text>
          <text x={VIEW_WIDTH - MARGIN.right} y={VIEW_HEIGHT - 6} textAnchor="end" fontSize={9} fill="var(--muted-foreground)">
            Day {Math.round(dayMax)}
          </text>

          {/* Vertical "current day" marker - dashed and muted since it's chrome, not a data series. */}
          {currentDay >= dayMin && currentDay <= dayMax && (
            <g>
              <line
                x1={xScale(currentDay)}
                x2={xScale(currentDay)}
                y1={MARGIN.top}
                y2={VIEW_HEIGHT - MARGIN.bottom}
                stroke="var(--muted-foreground)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
              <text x={xScale(currentDay)} y={MARGIN.top - 2} textAnchor="middle" fontSize={9} fill="var(--muted-foreground)">
                Today (Day {currentDay})
              </text>
            </g>
          )}

          {/* Hover crosshair */}
          {hoverDay !== undefined && (
            <line
              x1={xScale(hoverDay)}
              x2={xScale(hoverDay)}
              y1={MARGIN.top}
              y2={VIEW_HEIGHT - MARGIN.bottom}
              stroke="var(--foreground)"
              strokeWidth={1}
              strokeOpacity={0.3}
            />
          )}

          {/* One line per league, plus an end-dot so the last point stays legible where lines cross. */}
          {plotted.map((s) => (
            <g key={s.league}>
              <polyline
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={s.points.map((p) => `${xScale(p.dayOffset)},${yScale(p.value)}`).join(" ")}
              />
              {s.points.length > 0 && (
                <circle
                  cx={xScale(s.points[s.points.length - 1].dayOffset)}
                  cy={yScale(s.points[s.points.length - 1].value)}
                  r={3.5}
                  fill={s.color}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              )}
            </g>
          ))}

          {/* Transparent overlay capturing pointer position for the hover tooltip. */}
          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={PLOT_WIDTH}
            height={PLOT_HEIGHT}
            fill="transparent"
            onPointerMove={handlePointerMove}
            onPointerLeave={() => setHoverDay(undefined)}
          />
        </svg>

        {hoverDay !== undefined && hoverRows.length > 0 && (
          <div
            className="pointer-events-none absolute top-2 flex -translate-x-1/2 flex-col gap-0.5 rounded-md border border-border bg-popover p-2 text-xs shadow-sm"
            style={{ left: `${((xScale(hoverDay) / VIEW_WIDTH) * 100).toFixed(2)}%` }}
          >
            <span className="font-medium text-popover-foreground">Day {hoverDay}</span>
            {hoverRows.map(({ league, color, point }) => (
              <span key={league} className="flex items-center gap-1.5 text-muted-foreground">
                <span className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                {league}
                <span className="font-medium text-popover-foreground">{formatTick(point.value, priceUnit)}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Legend - always paired with text, never color alone, since a couple of the palette's hues
          read with weak contrast in light mode. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {plotted.map((s) => (
          <span key={s.league} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block h-0.5 w-3 shrink-0" style={{ backgroundColor: s.color }} />
            {s.league}
          </span>
        ))}
      </div>
    </div>
  );
}
