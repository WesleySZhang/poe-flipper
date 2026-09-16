"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "cn";
import { allKnownLeagues, CURRENT_LEAGUE } from "@/lib/league-recency";
import { activePrice, priceUnitLabel, type PriceUnit } from "@/lib/price-unit";
import type { LeagueSeries } from "@/lib/price-history";

export type PriceHistoryFetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; series: LeagueSeries[] };

// Fixed logical coordinate space for the main chart. The container is sized via CSS aspect-ratio
// (not a fixed height) so the rendered chart always keeps this exact 2.5:1 shape regardless of how
// wide its table cell ends up - a fixed height + preserveAspectRatio="none" used to stretch the
// chart vertically/horizontally out of proportion on a wide row.
const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 240;
// left is sized to fit the Y-axis price labels drawn next to each gridline (formatTick's longest
// typical output, e.g. "123.4c"). bottom fits two stacked rows of x-axis text: the current/target
// day labels, and below them the plotted day-range labels.
const MARGIN = { top: 12, right: 16, bottom: 34, left: 38 };
const PLOT_WIDTH = VIEW_WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = VIEW_HEIGHT - MARGIN.top - MARGIN.bottom;
const CHART_ASPECT_RATIO = `${VIEW_WIDTH} / ${VIEW_HEIGHT}`;
// The brush window can't shrink narrower than this many days, to avoid a degenerate/inverted zoom.
const MIN_ZOOM_DAYS = 1;
// A drag shorter than this (in view units) on the main chart is treated as a click/hover, not a
// deliberate zoom selection - otherwise every hover-then-slightly-move would zoom by accident.
const MIN_CHART_DRAG_VIEW_WIDTH = 8;
// The chart opens already zoomed to [currentDay - this, currentDay + this] (clamped to the actual
// data range) rather than the full history - a multi-hundred-day league squashes the trend around
// "now" into an unreadable sliver otherwise, and that's the window a trader actually cares about
// first. Still fully adjustable via the brush/drag afterward.
// Default zoom padding around [currentDay, targetDay] (or just currentDay, absent a targetDay) -
// proportional to that span rather than a fixed number of days, so Today/Target sit close to the
// window's edges regardless of whether the prediction is a few days or a few months.
const DEFAULT_ZOOM_PADDING_FRACTION = 0.1;
const DEFAULT_ZOOM_MIN_PADDING_DAYS = 2;
// Logical height of the brush's own mini-preview chart (its width tracks the track's rendered width
// via a 0-100 viewBox, since the track is already positioned with percentages).
const BRUSH_VIEW_HEIGHT = 40;
// Fraction of the data's log range added above and below the Y-axis domain, so a line sitting at
// the actual min/max isn't drawn flush against the plot edge (or the top/bottom gridline label).
const Y_AXIS_PADDING_FRACTION = 0.08;
// Shared size/color for every axis label (Y-axis price ticks and X-axis day labels alike), so they
// read as one consistent axis style rather than two different-looking sets of text.
const AXIS_FONT_SIZE = 7;
const AXIS_LABEL_COLOR = "var(--muted-foreground)";

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

type BrushDragMode = "left" | "right" | "move";

/**
 * Horizontal range brush below the main chart - a track spanning the full day range with a
 * draggable/resizable window over it, its background a miniature preview of the same lines the main
 * chart shows (over the FULL, unzoomed range) so there's something to aim the window at. Drag either
 * handle to resize the window (zoom in/out); drag the window's body to pan it. Percentage-positioned
 * HTML/CSS for the interactive pieces (simpler pointer math for a purely horizontal, linear-scale
 * control than another coordinate system), with a small 0-100-viewBox SVG behind them for the preview
 * lines - the 0-100 span matches the percentage math exactly, so both use the same day->position
 * formula.
 */
function RangeBrush({
  fullMin,
  fullMax,
  valueMin,
  valueMax,
  onChange,
  series,
  logDomain,
}: {
  fullMin: number;
  fullMax: number;
  valueMin: number;
  valueMax: number;
  onChange: (min: number, max: number) => void;
  series: PlottedSeries[];
  /** [logMin, logMax] over the FULL, unzoomed data - the preview always shows the whole history,
   *  regardless of the main chart's current zoom. */
  logDomain: [number, number];
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: BrushDragMode; startClientX: number; startMin: number; startMax: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fullRange = fullMax - fullMin || 1;
  const [logMin, logMax] = logDomain;

  function valueAtClientX(clientX: number): number {
    const track = trackRef.current;
    if (!track) return fullMin;
    const rect = track.getBoundingClientRect();
    const fraction = (clientX - rect.left) / rect.width;
    return fullMin + Math.min(1, Math.max(0, fraction)) * fullRange;
  }

  // Three directly-declared handlers rather than one factory called inline in JSX to produce a
  // closure per drag mode - React Compiler's ref-safety lint flags a ref write reachable through any
  // function invoked during render, even when the actual write only happens later inside a returned
  // event-handler closure. Each of these IS the handler (referenced, never called, in JSX), so
  // there's no such intermediate call for the lint to flag.
  function beginDrag(mode: BrushDragMode, e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode, startClientX: e.clientX, startMin: valueMin, startMax: valueMax };
    setIsDragging(true);
  }
  function handleLeftPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    beginDrag("left", e);
  }
  function handleRightPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    beginDrag("right", e);
  }
  function handleMovePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    beginDrag("move", e);
  }

  function handlePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "left") {
      const next = Math.min(valueAtClientX(e.clientX), drag.startMax - MIN_ZOOM_DAYS);
      onChange(Math.max(fullMin, next), drag.startMax);
    } else if (drag.mode === "right") {
      const next = Math.max(valueAtClientX(e.clientX), drag.startMin + MIN_ZOOM_DAYS);
      onChange(drag.startMin, Math.min(fullMax, next));
    } else {
      // "move" - pan the window, keeping its width fixed. Computed as a delta rather than an
      // absolute position, so panning doesn't jump if the pointer isn't exactly over the window.
      const delta = valueAtClientX(e.clientX) - valueAtClientX(drag.startClientX);
      const width = drag.startMax - drag.startMin;
      let nextMin = drag.startMin + delta;
      let nextMax = nextMin + width;
      if (nextMin < fullMin) {
        nextMin = fullMin;
        nextMax = fullMin + width;
      }
      if (nextMax > fullMax) {
        nextMax = fullMax;
        nextMin = fullMax - width;
      }
      onChange(nextMin, nextMax);
    }
  }

  function endDrag() {
    dragRef.current = null;
    setIsDragging(false);
  }

  const leftPct = ((valueMin - fullMin) / fullRange) * 100;
  const rightPct = ((valueMax - fullMin) / fullRange) * 100;
  const miniX = (day: number) => ((day - fullMin) / fullRange) * 100;
  const miniY = (value: number) => BRUSH_VIEW_HEIGHT * (1 - (Math.log(value) - logMin) / (logMax - logMin || 1));

  return (
    <div
      ref={trackRef}
      className="relative h-10 w-full overflow-hidden rounded-md border border-border bg-muted"
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Mini preview of the same lines the main chart shows, over the full history - purely
          decorative context for aiming the window, so it's not interactive itself. */}
      <svg
        viewBox={`0 0 100 ${BRUSH_VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        {series.map((s) => (
          <polyline
            key={s.league}
            fill="none"
            stroke={s.color}
            strokeWidth={1}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            points={s.points.map((p) => `${miniX(p.dayOffset)},${miniY(p.value)}`).join(" ")}
          />
        ))}
      </svg>

      {/* Dim the excluded portions so the selected window reads as "in focus" against the preview. */}
      <div className="absolute inset-y-0 left-0 bg-background/70" style={{ width: `${leftPct}%` }} />
      <div className="absolute inset-y-0 right-0 bg-background/70" style={{ width: `${100 - rightPct}%` }} />

      <div
        onPointerDown={handleMovePointerDown}
        className={cn(
          "absolute top-0 h-full border-x-2 border-foreground/70 bg-primary/20",
          isDragging ? "cursor-grabbing" : "cursor-grab"
        )}
        style={{ left: `${leftPct}%`, width: `${Math.max(0, rightPct - leftPct)}%` }}
      />
      <div
        onPointerDown={handleLeftPointerDown}
        className="absolute top-0 h-full w-2.5 -translate-x-1/2 cursor-ew-resize rounded-sm bg-foreground/60 hover:bg-foreground"
        style={{ left: `${leftPct}%` }}
      />
      <div
        onPointerDown={handleRightPointerDown}
        className="absolute top-0 h-full w-2.5 -translate-x-1/2 cursor-ew-resize rounded-sm bg-foreground/60 hover:bg-foreground"
        style={{ left: `${rightPct}%` }}
      />
    </div>
  );
}

/**
 * Per-item price history, one line per past league, with a vertical marker for the current day of
 * the league being predicted from. See lib/price-history.ts for why the live current league itself
 * never has a line here - only past, fully-ingested leagues do.
 *
 * A single item's leagues can have wildly different tracked lengths (a league that ran for a year
 * vs. one that ran for 90 days) - defaulting to the full combined day range would squash every
 * league's early, most-interesting action into a sliver at the left edge. Rather than guess a
 * "reasonable" default window, the full range is always the default and the range brush below the
 * chart lets the user pick whatever window they care about.
 */
export function PriceHistoryChart({
  state,
  currentDay,
  targetDay,
  priceUnit,
}: {
  state: PriceHistoryFetchState;
  currentDay: number;
  /** currentDay + the prediction's duration - drawn as a second marker line, the "end" to
   *  currentDay's "start". Undefined skips drawing it (no duration concept for this caller). */
  targetDay?: number;
  priceUnit: PriceUnit;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId();
  const [hoverDay, setHoverDay] = useState<number | undefined>();
  const [zoomDomain, setZoomDomain] = useState<[number, number] | undefined>();
  const [chartDragStartDay, setChartDragStartDay] = useState<number | undefined>();
  const [chartDragCurrentDay, setChartDragCurrentDay] = useState<number | undefined>();
  const [hasAutoZoomed, setHasAutoZoomed] = useState(false);

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

  // Default zoom to a tight window around [currentDay, targetDay], once, the first time real data
  // shows up - a guarded setState call during render (React's documented "adjust state during
  // rendering" pattern: https://react.dev/learn/you-might-not-need-an-effect), not an effect, so it
  // takes effect in the same render pass instead of causing an extra one. The hasAutoZoomed guard
  // means a later user-driven zoom, including an explicit reset back to the full range, is never
  // overridden by this again for this chart instance. Skipped entirely if the window wouldn't
  // actually be smaller than the full data range anyway.
  if (!hasAutoZoomed && plotted.length > 0) {
    setHasAutoZoomed(true);
    const fullMin = Math.min(0, ...allDays, currentDay, targetDay ?? currentDay);
    const fullMax = Math.max(...allDays, currentDay, targetDay ?? currentDay);
    // Padding proportional to the currentDay->targetDay span (with a small floor) rather than a
    // fixed number of days - keeps Today near the left edge and Target near the right edge
    // regardless of whether the prediction window is a few days or a few months, instead of a fixed
    // padding either overwhelming a short window or barely denting a long one.
    const coreMin = Math.min(currentDay, targetDay ?? currentDay);
    const coreMax = Math.max(currentDay, targetDay ?? currentDay);
    const padding = Math.max(DEFAULT_ZOOM_MIN_PADDING_DAYS, (coreMax - coreMin) * DEFAULT_ZOOM_PADDING_FRACTION);
    const desiredMin = Math.max(fullMin, coreMin - padding);
    const desiredMax = Math.min(fullMax, coreMax + padding);
    if (desiredMin > fullMin || desiredMax < fullMax) {
      setZoomDomain([desiredMin, desiredMax]);
    }
  }

  if (state.status === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground" style={{ aspectRatio: CHART_ASPECT_RATIO }}>
        <Loader2 className="size-4 animate-spin" />
        Loading price history...
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ aspectRatio: CHART_ASPECT_RATIO }}>
        Couldn&apos;t load price history.
      </div>
    );
  }

  if (plotted.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ aspectRatio: CHART_ASPECT_RATIO }}>
        {priceUnit === "divine"
          ? "No historical price data for this item in Divine terms - try Chaos mode."
          : "No historical price data for this item."}
      </div>
    );
  }

  const fullDayMin = Math.min(0, ...allDays, currentDay, targetDay ?? currentDay);
  const fullDayMax = Math.max(...allDays, currentDay, targetDay ?? currentDay);
  // The active (possibly zoomed) day domain, driven by the range brush below the chart - everything
  // else scales against this, not the full range.
  const dayMin = zoomDomain ? zoomDomain[0] : fullDayMin;
  const dayMax = zoomDomain ? zoomDomain[1] : fullDayMax;
  const dayRange = dayMax - dayMin || 1;

  // Y auto-rescales to whatever's actually visible in the current window, not the full history -
  // otherwise zooming into a flat stretch would still show it squashed against a scale set by a
  // price spike outside the visible window. Falls back to the full range if the window happens to
  // contain no points at all.
  const visibleValues = plotted.flatMap((s) =>
    s.points.filter((p) => p.dayOffset >= dayMin && p.dayOffset <= dayMax).map((p) => p.value)
  );
  const valuesForScale = visibleValues.length > 0 ? visibleValues : allValues;
  let logMin = Math.log(Math.min(...valuesForScale));
  let logMax = Math.log(Math.max(...valuesForScale));
  if (logMin === logMax) {
    // Flat or single-point data - pad the domain so the line isn't drawn on a degenerate 0-height
    // scale (divide-by-zero guard).
    logMin -= 0.5;
    logMax += 0.5;
  } else {
    // Headroom above/below the actual min/max so a line touching the top or bottom of its range
    // isn't drawn flush against the plot edge (or hidden behind the axis labels) - same idea as
    // the flat-data guard above, just proportional instead of a fixed padding.
    const padding = (logMax - logMin) * Y_AXIS_PADDING_FRACTION;
    logMin -= padding;
    logMax += padding;
  }
  // Separate, full-history log domain for the brush's own mini-preview, which always shows
  // everything regardless of the main chart's current zoom.
  let fullLogMin = Math.log(Math.min(...allValues));
  let fullLogMax = Math.log(Math.max(...allValues));
  if (fullLogMin === fullLogMax) {
    fullLogMin -= 0.5;
    fullLogMax += 0.5;
  } else {
    const fullPadding = (fullLogMax - fullLogMin) * Y_AXIS_PADDING_FRACTION;
    fullLogMin -= fullPadding;
    fullLogMax += fullPadding;
  }

  const xScale = (day: number) => MARGIN.left + ((day - dayMin) / dayRange) * PLOT_WIDTH;
  const yScale = (value: number) => MARGIN.top + (1 - (Math.log(value) - logMin) / (logMax - logMin)) * PLOT_HEIGHT;

  const yTicks = [0, 1 / 3, 2 / 3, 1].map((f) => Math.exp(logMin + f * (logMax - logMin)));
  const isZoomed = zoomDomain !== undefined;
  const isChartDragging = chartDragStartDay !== undefined && chartDragCurrentDay !== undefined;

  function dayAtClientX(clientX: number): number {
    const svg = svgRef.current;
    if (!svg) return dayMin;
    const rect = svg.getBoundingClientRect();
    const fraction = (clientX - rect.left) / rect.width;
    const viewX = fraction * VIEW_WIDTH;
    const day = dayMin + ((viewX - MARGIN.left) / PLOT_WIDTH) * dayRange;
    return Math.min(dayMax, Math.max(dayMin, day));
  }

  function handleBrushChange(min: number, max: number) {
    // Snap back to "not zoomed" once the window is dragged back out to (near) the full range,
    // rather than leaving a technically-zoomed-but-visually-identical state.
    if (min <= fullDayMin + 1e-6 && max >= fullDayMax - 1e-6) {
      setZoomDomain(undefined);
    } else {
      setZoomDomain([min, max]);
    }
  }

  function handleChartPointerDown(e: React.PointerEvent<SVGRectElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const day = dayAtClientX(e.clientX);
    setChartDragStartDay(day);
    setChartDragCurrentDay(day);
  }

  function handleChartPointerMove(e: React.PointerEvent<SVGRectElement>) {
    const day = dayAtClientX(e.clientX);
    if (chartDragStartDay !== undefined) {
      setChartDragCurrentDay(day);
    } else {
      setHoverDay(Math.round(day));
    }
  }

  function commitChartDrag() {
    if (chartDragStartDay !== undefined && chartDragCurrentDay !== undefined) {
      const from = Math.min(chartDragStartDay, chartDragCurrentDay);
      const to = Math.max(chartDragStartDay, chartDragCurrentDay);
      if (xScale(to) - xScale(from) >= MIN_CHART_DRAG_VIEW_WIDTH) {
        handleBrushChange(from, to);
      }
    }
    setChartDragStartDay(undefined);
    setChartDragCurrentDay(undefined);
  }

  // The +/- change badge only makes sense for a day genuinely ahead of "today" (comparing today's
  // price to itself, or to the past, isn't the "is this prediction playing out" question the badge
  // answers) - but not restricted to exactly the target day, so dragging the hover anywhere in the
  // future keeps it live.
  const showChangeBadge = hoverDay !== undefined && hoverDay > currentDay;

  // Nearest point per league to the hovered day, for the tooltip - not necessarily an exact day
  // match, since not every league has a recorded value on every single day.
  const hoverRows =
    hoverDay === undefined || isChartDragging
      ? []
      : plotted
          .map((s) => {
            const nearest = s.points.reduce((best, p) =>
              Math.abs(p.dayOffset - hoverDay) < Math.abs(best.dayOffset - hoverDay) ? p : best
            );
            let changePercent: number | undefined;
            if (showChangeBadge) {
              const atCurrentDay = s.points.reduce((best, p) =>
                Math.abs(p.dayOffset - currentDay) < Math.abs(best.dayOffset - currentDay) ? p : best
              );
              // Same "don't trust a distant nearest point" guard as the hover match below - a
              // league with no data anywhere near currentDay shouldn't get a fabricated baseline.
              if (Math.abs(atCurrentDay.dayOffset - currentDay) <= 5) {
                changePercent = (nearest.value / atCurrentDay.value - 1) * 100;
              }
            }
            return { league: s.league, color: s.color, point: nearest, changePercent };
          })
          // Ignore a "nearest" point that's actually far away - a league whose tracking doesn't
          // reach anywhere near the hovered day shouldn't show a misleading value.
          .filter(({ point }) => Math.abs(point.dayOffset - hoverDay) <= 5);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative w-full" style={{ aspectRatio: CHART_ASPECT_RATIO }}>
        <svg ref={svgRef} viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} className="h-full w-full overflow-visible">
          <defs>
            {/* Unique per instance (useId) - multiple rows can be expanded at once, and an SVG id
                reference resolves document-wide, not per-<svg>, so a shared literal id would let one
                chart's clip accidentally apply to another's. */}
            <clipPath id={clipId}>
              <rect x={MARGIN.left} y={MARGIN.top} width={PLOT_WIDTH} height={PLOT_HEIGHT} />
            </clipPath>
          </defs>

          {/* Y-axis gridlines with their price labels - exact values at a specific day are still
              read via the hover tooltip, but these give a sense of scale at a glance. */}
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
              <text
                x={MARGIN.left - 4}
                y={yScale(value)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={AXIS_FONT_SIZE}
                fill={AXIS_LABEL_COLOR}
              >
                {formatTick(value, priceUnit)}
              </text>
            </g>
          ))}

          {/* X-axis labels - current/target day markers on the row closest to the plot, the
              plotted day-range underneath. Rendered outside the clipped group below (which only
              covers the plot area itself) since these live in the bottom margin. */}
          {currentDay >= dayMin && currentDay <= dayMax && (
            <text x={xScale(currentDay)} y={VIEW_HEIGHT - MARGIN.bottom + 10} textAnchor="middle" fontSize={AXIS_FONT_SIZE} fill={AXIS_LABEL_COLOR}>
              Today (Day {currentDay})
            </text>
          )}
          {targetDay !== undefined && targetDay >= dayMin && targetDay <= dayMax && (
            <text x={xScale(targetDay)} y={VIEW_HEIGHT - MARGIN.bottom + 10} textAnchor="middle" fontSize={AXIS_FONT_SIZE} fill={AXIS_LABEL_COLOR}>
              Day {targetDay}
            </text>
          )}
          <text x={MARGIN.left} y={VIEW_HEIGHT - 6} textAnchor="start" fontSize={AXIS_FONT_SIZE} fill={AXIS_LABEL_COLOR}>
            Day {Math.round(dayMin)}
          </text>
          <text x={VIEW_WIDTH - MARGIN.right} y={VIEW_HEIGHT - 6} textAnchor="end" fontSize={AXIS_FONT_SIZE} fill={AXIS_LABEL_COLOR}>
            Day {Math.round(dayMax)}
          </text>

          <g clipPath={`url(#${clipId})`}>
            {/* Vertical "current day" / "target day" markers - the start and end of the prediction
                window being checked against history. Solid (not dashed) so they read as firm
                reference lines; identical styling for both since their text labels above (outside
                this clipped group) already say which is which. */}
            {currentDay >= dayMin && currentDay <= dayMax && (
              <line
                x1={xScale(currentDay)}
                x2={xScale(currentDay)}
                y1={MARGIN.top}
                y2={VIEW_HEIGHT - MARGIN.bottom}
                stroke="var(--destructive)"
                strokeWidth={1.5}
              />
            )}
            {targetDay !== undefined && targetDay >= dayMin && targetDay <= dayMax && (
              <line
                x1={xScale(targetDay)}
                x2={xScale(targetDay)}
                y1={MARGIN.top}
                y2={VIEW_HEIGHT - MARGIN.bottom}
                stroke="var(--destructive)"
                strokeWidth={1.5}
              />
            )}

            {/* Hover crosshair */}
            {hoverDay !== undefined && !isChartDragging && (
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
                  strokeWidth={1.5}
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

            {/* Drag-to-zoom selection - dragging directly on the chart is a shortcut for the same
                zoom the range brush below controls; both drive the same zoomDomain state. */}
            {isChartDragging && chartDragStartDay !== undefined && chartDragCurrentDay !== undefined && (
              <rect
                x={Math.min(xScale(chartDragStartDay), xScale(chartDragCurrentDay))}
                y={MARGIN.top}
                width={Math.abs(xScale(chartDragCurrentDay) - xScale(chartDragStartDay))}
                height={PLOT_HEIGHT}
                fill="var(--primary)"
                fillOpacity={0.15}
                stroke="var(--foreground)"
                strokeOpacity={0.4}
              />
            )}
          </g>

          {/* Transparent overlay capturing pointer position for hover + drag-to-zoom. */}
          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={PLOT_WIDTH}
            height={PLOT_HEIGHT}
            fill="transparent"
            style={{ touchAction: "none", cursor: "crosshair" }}
            onPointerDown={handleChartPointerDown}
            onPointerMove={handleChartPointerMove}
            onPointerUp={commitChartDrag}
            onPointerLeave={() => {
              setHoverDay(undefined);
              if (isChartDragging) commitChartDrag();
            }}
          />
        </svg>

        {hoverDay !== undefined && !isChartDragging && hoverRows.length > 0 && (
          <div
            className="pointer-events-none absolute top-2 -translate-x-1/2 overflow-hidden rounded-md border border-border shadow-sm"
            style={{ left: `${((xScale(hoverDay) / VIEW_WIDTH) * 100).toFixed(2)}%` }}
          >
            {/* Translucent/blurred backdrop as its own layer, behind the text - keeps the text at
                full opacity regardless of how transparent this background is. */}
            <div className="absolute inset-0 bg-popover/55 backdrop-blur-[1px]" />
            <div className="relative flex flex-col gap-0.5 p-2 text-xs">
              <span className="font-medium text-popover-foreground">Day {hoverDay}</span>
              {hoverRows.map(({ league, color, point, changePercent }) => (
                <span key={league} className="flex items-center gap-1.5">
                  <span className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-popover-foreground">{league}</span>
                  <span className="font-medium text-popover-foreground">{formatTick(point.value, priceUnit)}</span>
                  {changePercent !== undefined && (
                    <span
                      className={cn(
                        "font-medium",
                        changePercent >= 0 ? "text-green-600 dark:text-green-500" : "text-red-600 dark:text-red-500"
                      )}
                    >
                      {changePercent >= 0 ? "+" : ""}
                      {changePercent.toFixed(0)}%
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Range brush - aligned under the plot area (not the Y-axis labels) via the same margin
          proportions as the chart above it. */}
      <div style={{ paddingLeft: `${(MARGIN.left / VIEW_WIDTH) * 100}%`, paddingRight: `${(MARGIN.right / VIEW_WIDTH) * 100}%` }}>
        <RangeBrush
          fullMin={fullDayMin}
          fullMax={fullDayMax}
          valueMin={dayMin}
          valueMax={dayMax}
          onChange={handleBrushChange}
          series={plotted}
          logDomain={[fullLogMin, fullLogMax]}
        />
      </div>
      <div className="flex items-center justify-between px-1">
        <span className="text-xs text-muted-foreground">Drag the window&apos;s edges to resize, or its middle to pan.</span>
        {isZoomed && (
          <button
            type="button"
            onClick={() => setZoomDomain(undefined)}
            className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
          >
            Reset zoom
          </button>
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
