"use client";

/**
 * Equity-Kurve als SVG-Chart — Achsen, Raster, Drawdown, Trade-Marker,
 * Hover-/Tastatur-Tooltip, Vergleichslinien. Keine Chart-Dependency
 * (Repo-Regel: keine neuen Runtime-Abhängigkeiten), dafür volle Kontrolle über
 * Beschriftung, Barrierefreiheit und Theming (Farben laufen über
 * Tailwind-Klassen, damit alle `data-theme`-Varianten funktionieren).
 *
 * Aufbau (von oben nach unten):
 *   1. Hauptchart — Equity über **echter Zeitachse** (nicht Index), y-Achse
 *      wahlweise **linear oder logarithmisch** (`logScale`), „schöne“ Ticks,
 *      Basislinie (Zeitraumstart bzw. Startkapital), optional schraffierter
 *      Max-Drawdown-Bereich, Trade-Marker und bis zu zwei Vergleichslinien
 *      (Referenzwert/Benchmark und zweiter Zeitraum).
 *   2. Unterwasser-Kurve (Drawdown in % vom jeweiligen Höchststand) — nur wenn
 *      `showDrawdown`.
 *
 * Vergleichslinien: Der Benchmark kommt bereits in Kontowährung skaliert von
 * der API (Buy-and-Hold mit dem Kontostand des Fensterstarts), der zweite
 * Zeitraum wird von der UI auf denselben Startpunkt indexiert. Beide teilen
 * dadurch denselben Startpunkt wie die Hauptkurve — in beiden Achsenmodi.
 *
 * Interaktion: Maus-Hover, Touch/Pointer, Tastatur (←/→, Pos1/Ende, Esc) und
 * ein `aria-live`-Text für Screenreader. Der Tooltip ist **HTML** über dem
 * SVG (nicht SVG-Text), damit er nicht mitskaliert und selektierbar bleibt.
 *
 * Die Mathematik (Ticks, Formatierung) liegt in `@/lib/equityAnalytics` —
 * dieselbe Quelle wie die API, damit Achse und Server-Kennzahl nie
 * auseinanderlaufen.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  buildTimeTicks,
  formatAxisValue,
  formatMoney,
  formatPct,
  formatPercentTick,
  formatTimeTick,
  formatTimestamp,
  niceLogTicks,
  niceTicks,
  triggerLabel,
  type EquityCurvePoint,
  type EquityMarker,
} from "@/lib/equityAnalytics";

/** Ein Punkt einer Vergleichslinie (bereits skaliert/indexiert). */
export type ComparisonSeries = {
  label: string;
  points: Array<{ ts: string; value: number }>;
  /** Rendite der Reihe über das Fenster (Prozent), falls bekannt. */
  returnPct?: number | null;
};

export type EquityCurveChartProps = {
  points: EquityCurvePoint[];
  markers?: EquityMarker[];
  /** `absolute` = Kontowährung, `percent` = Index (Zeitraumstart = 100). */
  mode?: "absolute" | "percent";
  /** Logarithmische y-Achse (prozentuale Abstände statt absoluter). */
  logScale?: boolean;
  showDrawdown?: boolean;
  showTrades?: boolean;
  /** Höhe des Hauptcharts in Pixeln (Unterwasser-Kurve kommt hinzu). */
  height?: number;
  /** Kennzahl aus der API für die Max-Drawdown-Markierung (optional). */
  maxDrawdown?: { fromTs: string | null; toTs: string | null; pct: number } | null;
  /** Referenzlinie (Benchmark), in Kontowährung skaliert. */
  benchmark?: ComparisonSeries | null;
  /** Zweiter Zeitraum zum Vergleich (auf den Start indexiert). */
  compare?: ComparisonSeries | null;
};

const MARGIN = { top: 18, right: 20, bottom: 26, left: 76 } as const;
const DRAWDOWN_HEIGHT = 84;
const MIN_WIDTH = 320;

/** Ordnet jedem Kurvenpunkt einen Wert der Vergleichsreihe zu (nächster ts). */
function alignToSeries(
  timestamps: number[],
  series: Array<{ ts: string; value: number }>
): number[] {
  if (series.length === 0) return [];
  const parsed = series
    .map((p) => ({ ts: Date.parse(p.ts), value: p.value }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.value))
    .sort((a, b) => a.ts - b.ts);
  if (parsed.length === 0) return [];
  return timestamps.map((ts) => {
    let best = parsed[0];
    let bestDelta = Math.abs(parsed[0].ts - ts);
    for (const candidate of parsed) {
      const delta = Math.abs(candidate.ts - ts);
      if (delta < bestDelta) {
        best = candidate;
        bestDelta = delta;
      }
    }
    return best.value;
  });
}

export default function EquityCurveChart({
  points,
  markers = [],
  mode = "absolute",
  logScale = false,
  showDrawdown = true,
  showTrades = true,
  height = 250,
  maxDrawdown = null,
  benchmark = null,
  compare = null,
}: EquityCurveChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // `useId` kann Sonderzeichen liefern (React 18 `:r0:`, React 19 `«r0»`) —
  // SVG-`url(#…)` braucht einen stabilen, einfachen Bezeichner.
  const gradientId = `eq${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const drawdownGradientId = `${gradientId}-dd`;

  // Breite messen (kein `preserveAspectRatio="none"`): nur so passen
  // Mauskoordinaten, Textgrößen und Skalierung exakt zusammen.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = (w: number) => setWidth((prev) => (w > 0 && Math.abs(prev - w) > 1 ? w : prev));
    apply(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) apply(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** SVG-Breite: nie schmaler als `MIN_WIDTH`, sonst kollidieren die Labels. */
  const svgWidth = Math.max(MIN_WIDTH, width);

  const chart = useMemo(() => {
    if (points.length < 2) return null;
    const first = points[0].equity;
    const display = (p: EquityCurvePoint) =>
      mode === "percent" && first > 0 ? (p.equity / first) * 100 : p.equity;

    const t0 = Date.parse(points[0].ts);
    const t1 = Date.parse(points[points.length - 1].ts);
    const span = Math.max(1, t1 - t0);

    const timestamps = points.map((p) => Date.parse(p.ts));
    const values = points.map(display);
    /** Vergleichsreihen in derselben Skala wie die Hauptkurve. */
    const benchmarkValues =
      benchmark && benchmark.points.length > 1 ? alignToSeries(timestamps, benchmark.points) : [];
    const compareValues =
      compare && compare.points.length > 1 ? alignToSeries(timestamps, compare.points) : [];

    let min = Math.min(...values);
    let max = Math.max(...values);
    for (const list of [benchmarkValues, compareValues]) {
      for (const value of list) {
        if (Number.isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }
    if (mode === "absolute") {
      // Die Basislinie (Zeitraumstart) soll sichtbar bleiben.
      min = Math.min(min, first);
      max = Math.max(max, first);
    }
    // Log-Achse: nur mit strikt positiven Werten sinnvoll. Enthält die Kurve
    // Null oder Negatives (theoretisch möglich), bleibt es bei linear — statt
    // eine Achse zu zeichnen, die die Daten nicht abbilden kann.
    const useLog = logScale && min > 0;
    let yMin: number;
    let yMax: number;
    if (useLog) {
      // Der Rand wird multiplikativ gerechnet: bei einem additiven Rand von
      // 8 % könnte yMin unter 0 rutschen (Spanne über zwei Zehnerpotenzen) —
      // die Log-Achse fiele dann still auf linear zurück.
      const lgPad = Math.max(0.004, Math.log10(max / min) * 0.08);
      yMin = min / 10 ** lgPad;
      yMax = max * 10 ** lgPad;
    } else {
      const pad = (max - min || Math.max(1, Math.abs(max) * 0.01)) * 0.08;
      yMin = min - pad;
      yMax = max + pad;
    }

    const innerLeft = MARGIN.left;
    const innerRight = Math.max(MARGIN.left + 40, svgWidth - MARGIN.right);
    const innerTop = MARGIN.top;
    const innerBottom = MARGIN.top + height;

    const x = (ts: number) => innerLeft + ((ts - t0) / span) * (innerRight - innerLeft);
    const yLinear = (value: number) =>
      innerBottom - ((value - yMin) / (yMax - yMin || 1)) * (innerBottom - innerTop);
    /** Logarithmische Abbildung: linear in log₁₀(value). */
    const lgMin = Math.log10(Math.max(1e-9, yMin));
    const lgMax = Math.log10(Math.max(1e-9, yMax));
    const yLog = (value: number) =>
      innerBottom -
      ((Math.log10(Math.max(1e-9, value)) - lgMin) / (lgMax - lgMin || 1)) * (innerBottom - innerTop);
    const y = (value: number) => (useLog ? yLog(value) : yLinear(value));

    const xs = points.map((p) => x(Date.parse(p.ts)));
    const ys = values.map(y);

    const pathOf = (list: number[]) =>
      list.map((value, i) => `${i === 0 ? "M" : "L"}${xs[i].toFixed(2)},${y(value).toFixed(2)}`).join(" ");
    const linePath = pathOf(values);
    const benchmarkPath = benchmarkValues.length > 1 ? pathOf(benchmarkValues) : null;
    const comparePath = compareValues.length > 1 ? pathOf(compareValues) : null;
    const areaPath = `${linePath} L${xs[xs.length - 1].toFixed(2)},${innerBottom} L${xs[0].toFixed(2)},${innerBottom} Z`;

    const rawTicks = useLog ? niceLogTicks(yMin, yMax, 5) : niceTicks(yMin, yMax, 5);
    const yTicks = rawTicks.filter((v) => v >= yMin - 1e-9 && v <= yMax + 1e-9);
    const xTicks = buildTimeTicks(t0, t1, Math.max(3, Math.min(8, Math.floor(svgWidth / 130))));

    const baselineValue = mode === "percent" ? 100 : first;
    const baselineY = y(baselineValue);

    // Max-Drawdown-Band (Peak → Trough) hervorheben.
    let ddBand: { x1: number; x2: number; yTop: number; yBottom: number } | null = null;
    const ddFrom = maxDrawdown?.fromTs;
    const ddTo = maxDrawdown?.toTs;
    if (ddFrom && ddTo && (maxDrawdown?.pct ?? 0) > 0) {
      const fromMs = Date.parse(ddFrom);
      const toMs = Date.parse(ddTo);
      if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
        const peakPoint = points.reduce((acc, p) =>
          Math.abs(Date.parse(p.ts) - fromMs) < Math.abs(Date.parse(acc.ts) - fromMs) ? p : acc
        );
        const troughPoint = points.reduce((acc, p) =>
          Math.abs(Date.parse(p.ts) - toMs) < Math.abs(Date.parse(acc.ts) - toMs) ? p : acc
        );
        const top = y(display(peakPoint));
        const bottom = y(display(troughPoint));
        ddBand = {
          x1: x(Date.parse(peakPoint.ts)),
          x2: x(Date.parse(troughPoint.ts)),
          yTop: Math.min(top, bottom),
          yBottom: Math.max(top, bottom),
        };
      }
    }

    // Unterwasser-Kurve.
    const maxDd = Math.max(0.5, ...points.map((p) => p.drawdownPct ?? 0));
    const ddTop = innerBottom + MARGIN.bottom + 10;
    const ddBottom = ddTop + DRAWDOWN_HEIGHT - 22;
    const ddY = (ddPct: number) => ddTop + (Math.max(0, ddPct) / maxDd) * (ddBottom - ddTop);
    const ddPath =
      points.map((p, i) => `${i === 0 ? "M" : "L"}${xs[i].toFixed(2)},${ddY(p.drawdownPct ?? 0).toFixed(2)}`).join(" ") +
      ` L${xs[xs.length - 1].toFixed(2)},${ddTop.toFixed(2)} L${xs[0].toFixed(2)},${ddTop.toFixed(2)} Z`;
    const ddLine = points.map((p, i) => `${i === 0 ? "M" : "L"}${xs[i].toFixed(2)},${ddY(p.drawdownPct ?? 0).toFixed(2)}`).join(" ");

    const totalHeight = showDrawdown ? ddTop + DRAWDOWN_HEIGHT : innerBottom + MARGIN.bottom;

    return {
      first, display, t0, t1, x, y, xs, ys, linePath, areaPath, yTicks, xTicks,
      /** Dekaden-Spanne: erst ab einer vollen Dekade ist „log“ sichtbar anders. */
      logSpan: lgMax - lgMin,
      baselineY, baselineValue, innerLeft, innerRight, innerTop, innerBottom,
      ddBand, maxDd, ddTop, ddBottom, ddY, ddPath, ddLine, totalHeight,
      useLog, benchmarkValues, compareValues, benchmarkPath, comparePath,
    };
  }, [points, mode, logScale, showDrawdown, svgWidth, height, maxDrawdown, benchmark, compare]);

  // Marker auf Kurvenpunkte abbilden (nächster Zeitstempel).
  const markerViews = useMemo(() => {
    if (!chart || !showTrades || markers.length === 0) return [];
    const timeFrom = (ts: string) => Date.parse(ts);
    const nearest = (tsMs: number) => {
      let best = 0;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (let i = 0; i < points.length; i += 1) {
        const delta = Math.abs(timeFrom(points[i].ts) - tsMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = i;
        }
      }
      return best;
    };
    // Bei sehr vielen Trades bleiben die Ausstiege (mit P&L) sichtbar.
    const list = markers.length > 80 ? markers.filter((m) => m.kind === "EXIT") : markers;
    return list.slice(0, 160).map((m) => {
      const index = nearest(timeFrom(m.ts));
      return { marker: m, index, x: chart.xs[index], y: chart.ys[index] };
    });
  }, [chart, markers, points, showTrades]);

  const active =
    activeIndex !== null && points[activeIndex]
      ? {
          index: activeIndex,
          point: points[activeIndex],
          x: chart ? chart.xs[activeIndex] : 0,
          y: chart ? chart.ys[activeIndex] : 0,
          marker: markerViews.find((m) => m.index === activeIndex)?.marker ?? null,
          benchmarkValue: chart && chart.benchmarkValues.length > activeIndex ? chart.benchmarkValues[activeIndex] : null,
          compareValue: chart && chart.compareValues.length > activeIndex ? chart.compareValues[activeIndex] : null,
        }
      : null;

  const nearestIndex = (clientX: number, element: SVGSVGElement): number | null => {
    if (!chart) return null;
    const rect = element.getBoundingClientRect();
    // Bei sehr schmalen Containern skaliert CSS die SVG-Breite herunter
    // (`max-w-full`) — der Faktor hält die Mausposition trotzdem exakt.
    const scale = rect.width > 0 ? svgWidth / rect.width : 1;
    const px = (clientX - rect.left) * scale;
    let best = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < chart.xs.length; i += 1) {
      const delta = Math.abs(chart.xs[i] - px);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    return best;
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (!chart) return;
    const last = points.length - 1;
    const step = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const base = activeIndex ?? last;
      const next = Math.min(last, Math.max(0, base + (event.key === "ArrowRight" ? step : -step)));
      setActiveIndex(next);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(last);
    } else if (event.key === "Escape") {
      setActiveIndex(null);
    }
  };

  if (points.length < 2) {
    return (
      <div
        ref={wrapRef}
        className="flex h-40 items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-6 text-center text-sm text-slate-400"
      >
        Noch zu wenig Historie für die Kurve — der Monitor schreibt bei jedem Tick (60 s) und bei jedem Trade
        einen Punkt.
      </div>
    );
  }

  const spanMs = chart ? chart.t1 - chart.t0 : 0;
  /** Verhältnis SVG-Koordinate → CSS-Pixel (1, solange nicht herunterskaliert). */
  const tooltipScale = width > 0 && svgWidth > 0 ? Math.min(1, width / svgWidth) : 1;
  const lastPoint = points[points.length - 1];
  const trendUp = lastPoint.equity >= points[0].equity;
  const strokeClass = trendUp ? "stroke-emerald-400" : "stroke-red-400";
  const fillClass = trendUp ? "fill-emerald-400" : "fill-red-400";
  const percentOfStart = chart && chart.first > 0 ? ((lastPoint.equity - chart.first) / chart.first) * 100 : 0;
  const valueLabel = (value: number) =>
    mode === "percent" ? `${value.toFixed(1)}` : formatMoney(value);

  const summaryText =
    `Equity-Kurve von ${formatTimestamp(points[0].ts)} bis ${formatTimestamp(lastPoint.ts)}: ` +
    `${formatMoney(lastPoint.equity)} (${formatPct(percentOfStart)} im Zeitraum), ` +
    `maximaler Drawdown ${formatPct(-(maxDrawdown?.pct ?? Math.max(...points.map((p) => p.drawdownPct ?? 0))), 2)}` +
    (chart?.useLog ? ", y-Achse logarithmisch" : "") +
    (benchmark ? `, Referenz ${benchmark.label}` : "") +
    (compare ? `, Vergleich ${compare.label}` : "");

  const activeText = active
    ? `${formatTimestamp(active.point.ts)}: Equity ${formatMoney(active.point.equity)}, ` +
      `Drawdown ${formatPct(-(active.point.drawdownPct ?? 0))}, Höchststand ${formatMoney(active.point.peak)}` +
      (active.benchmarkValue != null ? `, Referenz ${valueLabel(active.benchmarkValue)}` : "") +
      (active.compareValue != null ? `, Vergleichszeitraum ${valueLabel(active.compareValue)}` : "") +
      (active.marker ? `, Trade ${active.marker.symbol} ${active.marker.kind === "ENTRY" ? "Einstieg" : "Ausstieg"}` : "")
    : "";

  return (
    <figure ref={wrapRef} className="relative m-0 w-full" aria-label="Equity-Kurve">
      <svg
        width={svgWidth}
        height={chart?.totalHeight ?? height}
        viewBox={`0 0 ${svgWidth} ${chart?.totalHeight ?? height}`}
        className="max-w-full touch-pan-y select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        role="img"
        aria-label={summaryText}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerMove={(event) => setActiveIndex(nearestIndex(event.clientX, event.currentTarget))}
        onPointerLeave={() => setActiveIndex(null)}
        onBlur={() => setActiveIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className={fillClass} stopOpacity="0.28" />
            <stop offset="100%" className={fillClass} stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id={drawdownGradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="fill-red-500" stopOpacity="0.02" />
            <stop offset="100%" className="fill-red-500" stopOpacity="0.3" />
          </linearGradient>
        </defs>

        {/* ── Raster + y-Achse ─────────────────────────────────────────── */}
        {chart?.yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line
              x1={chart.innerLeft}
              x2={chart.innerRight}
              y1={chart.y(tick)}
              y2={chart.y(tick)}
              className="stroke-slate-700/50"
              strokeWidth="1"
            />
            <text
              x={chart.innerLeft - 8}
              y={chart.y(tick) + 3}
              textAnchor="end"
              className="fill-slate-500 text-[11px] tabular-nums"
            >
              {mode === "percent" ? tick.toFixed(1) : formatAxisValue(tick)}
            </text>
          </g>
        ))}
        <text x={4} y={12} className="fill-slate-500 text-[11px] font-semibold uppercase tracking-wider">
          {mode === "absolute" ? "Equity (USD)" : "Index (Start = 100)"}
          {/* „log“ nur ausweisen, wenn die Achse sichtbar anders skaliert —
              innerhalb einer Dekade sind log und linear deckungsgleich. */}
          {chart?.useLog && (chart.logSpan ?? 0) >= 1 ? " · log" : ""}
        </text>

        {/* ── x-Achse ──────────────────────────────────────────────────── */}
        <line
          x1={chart?.innerLeft}
          x2={chart?.innerRight}
          y1={chart?.innerBottom}
          y2={chart?.innerBottom}
          className="stroke-slate-600"
          strokeWidth="1"
        />
        {chart?.xTicks.map((tick) => (
          <g key={`x-${tick}`}>
            <line
              x1={chart.x(tick)}
              x2={chart.x(tick)}
              y1={chart.innerTop}
              y2={chart.innerBottom}
              className="stroke-slate-700/30"
              strokeWidth="1"
            />
            <text x={chart.x(tick)} y={chart.innerBottom + 14} textAnchor="middle" className="fill-slate-500 text-[11px]">
              {formatTimeTick(tick, spanMs)}
            </text>
          </g>
        ))}
        <text
          x={chart?.innerRight ?? 0}
          y={(chart?.innerBottom ?? 0) + 24}
          textAnchor="end"
          className="fill-slate-500 text-[11px]"
        >
          Zeit (Europe/Berlin)
        </text>

        {/* ── Max-Drawdown-Band ───────────────────────────────────────── */}
        {chart?.ddBand && (
          <rect
            x={chart.ddBand.x1}
            y={chart.ddBand.yTop}
            width={Math.max(1, chart.ddBand.x2 - chart.ddBand.x1)}
            height={Math.max(1, chart.ddBand.yBottom - chart.ddBand.yTop)}
            className="fill-red-500/10 stroke-red-500/40"
            strokeDasharray="3 3"
          />
        )}

        {/* ── Basislinie (Zeitraumstart) ───────────────────────────────── */}
        <line
          x1={chart?.innerLeft}
          x2={chart?.innerRight}
          y1={chart?.baselineY}
          y2={chart?.baselineY}
          className="stroke-slate-400/70"
          strokeDasharray="4 4"
          strokeWidth="1"
        />
        <text
          x={(chart?.innerRight ?? 0) - 4}
          y={(chart?.baselineY ?? 0) - 4}
          textAnchor="end"
          className="fill-slate-400 text-[11px] tabular-nums"
        >
          {mode === "absolute" ? `Start ${formatAxisValue(chart?.baselineValue ?? 0)}` : "Start = 100"}
        </text>

        {/* ── Fläche + Linie ──────────────────────────────────────────── */}
        <path d={chart?.areaPath} fill={`url(#${gradientId})`} />
        <path d={chart?.linePath} fill="none" strokeWidth="2" className={strokeClass} strokeLinejoin="round" />

        {/* ── Vergleichslinien: zweiter Zeitraum + Referenz ────────────── */}
        {chart?.comparePath && (
          <path
            d={chart.comparePath}
            fill="none"
            strokeWidth="1.5"
            className="stroke-sky-400/80"
            strokeDasharray="1 3"
            strokeLinecap="round"
          />
        )}
        {chart?.benchmarkPath && (
          <path
            d={chart.benchmarkPath}
            fill="none"
            strokeWidth="1.5"
            className="stroke-slate-300/80"
            strokeDasharray="6 4"
            strokeLinecap="round"
          />
        )}

        {/* ── Trade-Marker ─────────────────────────────────────────────── */}
        {showTrades &&
          markerViews.map(({ marker, index, x, y }) => {
            const isEntry = marker.kind === "ENTRY";
            const long = String(marker.side).toUpperCase() !== "SHORT";
            const colorClass = isEntry
              ? long
                ? "fill-emerald-300"
                : "fill-amber-300"
              : (marker.pnl ?? 0) >= 0
                ? "fill-sky-300"
                : "fill-rose-400";
            const size = isEntry ? 5 : 3.4;
            return (
              <g key={marker.id} className="cursor-pointer">
                <title>
                  {`${isEntry ? "Einstieg" : "Ausstieg"} ${marker.symbol} ${marker.side} am ${formatTimestamp(marker.ts)}` +
                    (!isEntry && typeof marker.pnl === "number" ? ` · P&L ${formatMoney(marker.pnl)}` : "")}
                </title>
                {isEntry ? (
                  <polygon
                    points={`${x},${y - size - 2} ${x - size},${y + size} ${x + size},${y + size}`}
                    className={colorClass}
                    opacity="0.95"
                  />
                ) : (
                  <circle cx={x} cy={y} r={size} className={colorClass} opacity="0.95" />
                )}
                <circle cx={x} cy={y} r={Math.max(8, size + 4)} fill="transparent" />
                {activeIndex === index && (
                  <circle cx={x} cy={y} r={size + 3} className="fill-none stroke-slate-200" strokeWidth="1.5" />
                )}
              </g>
            );
          })}

        {/* ── Crosshair + aktiver Punkt ────────────────────────────────── */}
        {active && chart && (
          <g pointerEvents="none">
            <line
              x1={active.x}
              x2={active.x}
              y1={chart.innerTop}
              y2={showDrawdown ? chart.ddBottom : chart.innerBottom}
              className="stroke-sky-400/70"
              strokeDasharray="3 3"
            />
            <circle cx={active.x} cy={active.y} r="3.5" className="fill-sky-300 stroke-slate-900" strokeWidth="1" />
            {active.benchmarkValue != null && Number.isFinite(active.benchmarkValue) && (
              <circle
                cx={active.x}
                cy={chart.y(active.benchmarkValue)}
                r="3"
                className="fill-slate-300 stroke-slate-900"
                strokeWidth="0.5"
              />
            )}
            {active.compareValue != null && Number.isFinite(active.compareValue) && (
              <circle
                cx={active.x}
                cy={chart.y(active.compareValue)}
                r="3"
                className="fill-sky-400 stroke-slate-900"
                strokeWidth="0.5"
              />
            )}
          </g>
        )}

        {/* ── Unterwasser-Kurve (Drawdown) ─────────────────────────────── */}
        {showDrawdown && chart && (
          <g>
            <text x={4} y={chart.ddTop - 4} className="fill-slate-500 text-[11px] font-semibold uppercase tracking-wider">
              Drawdown vom Höchststand
            </text>
            {[0, chart.maxDd / 2, chart.maxDd].map((tick, i) => (
              <g key={`dd-${i}`}>
                <line
                  x1={chart.innerLeft}
                  x2={chart.innerRight}
                  y1={chart.ddY(tick)}
                  y2={chart.ddY(tick)}
                  className="stroke-slate-700/40"
                  strokeWidth="1"
                />
                <text
                  x={chart.innerLeft - 8}
                  y={chart.ddY(tick) + 3}
                  textAnchor="end"
                  className="fill-red-300/80 text-[11px] tabular-nums"
                >
                  {`−${formatPercentTick(tick)}`}
                </text>
              </g>
            ))}
            <path d={chart.ddPath} fill={`url(#${drawdownGradientId})`} />
            <path d={chart.ddLine} fill="none" strokeWidth="1.5" className="stroke-red-400" />
            {active && (
              <circle cx={active.x} cy={chart.ddY(active.point.drawdownPct ?? 0)} r="3" className="fill-red-300" />
            )}
          </g>
        )}
      </svg>

      {/* ── Tooltip (HTML, nicht mitskaliert) ─────────────────────────── */}
      {active && chart && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 w-64 rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs leading-snug text-slate-200 shadow-xl"
          style={{
            // Die SVG ist im Container auf `max-w-full` begrenzt; der Faktor
            // rechnet die SVG-Koordinaten auf die tatsächliche Containerbreite
            // um, damit der Tooltip am Punkt klebt (auch auf schmalen Screens).
            left: `${Math.min(Math.max(8, tooltipScale * active.x + 14), Math.max(8, width - 268))}px`,
            top: `${Math.max(8, Math.min(tooltipScale * active.y - 8, (chart.totalHeight ?? height) - 150))}px`,
          }}
        >
          <p className="font-semibold text-slate-100">{formatTimestamp(active.point.ts, { withSeconds: true })}</p>
          <p className="mt-1 flex items-center justify-between gap-2">
            <span className="text-slate-400">Equity</span>
            <span className="font-mono font-semibold tabular-nums">{formatMoney(active.point.equity)}</span>
          </p>
          <p className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Seit Zeitraumstart</span>
            <span className={`font-mono tabular-nums ${percentOfStart >= 0 ? "text-emerald-300" : "text-red-300"}`}>
              {formatPct(chart.first > 0 ? ((active.point.equity - chart.first) / chart.first) * 100 : 0)}
            </span>
          </p>
          <p className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Drawdown</span>
            <span className="font-mono tabular-nums text-red-300">
              {formatPct(-(active.point.drawdownPct ?? 0))} ({formatMoney(-(active.point.drawdownAbs ?? 0))})
            </span>
          </p>
          <p className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Höchststand</span>
            <span className="font-mono tabular-nums text-slate-300">{formatMoney(active.point.peak)}</span>
          </p>
          {active.benchmarkValue != null && Number.isFinite(active.benchmarkValue) && (
            <p className="flex items-center justify-between gap-2">
              <span className="text-slate-400">{benchmark?.label ?? "Referenz"}</span>
              <span className="font-mono tabular-nums text-slate-300">{valueLabel(active.benchmarkValue)}</span>
            </p>
          )}
          {active.compareValue != null && Number.isFinite(active.compareValue) && (
            <p className="flex items-center justify-between gap-2">
              <span className="text-slate-400">{compare?.label ?? "Vergleich"}</span>
              <span className="font-mono tabular-nums text-sky-300">{valueLabel(active.compareValue)}</span>
            </p>
          )}
          <p className="mt-1 border-t border-slate-800 pt-1 text-slate-400">
            Auslöser: <span className="text-slate-300">{triggerLabel(active.point.trigger)}</span>
          </p>
          {active.marker && (
            <p className="mt-1 border-t border-slate-800 pt-1 text-slate-300">
              {active.marker.kind === "ENTRY" ? "▲ Einstieg" : "● Ausstieg"} {active.marker.symbol} {active.marker.side}
              {typeof active.marker.pnl === "number" && (
                <span className={active.marker.pnl >= 0 ? "text-emerald-300" : "text-red-300"}>
                  {" "}
                  · P&L {formatMoney(active.marker.pnl)}
                </span>
              )}
              {active.marker.exitReason ? ` · ${active.marker.exitReason}` : ""}
            </p>
          )}
          <p className="mt-1 text-[11px] text-slate-500">← → bewegt die Auswahl, Esc schließt.</p>
        </div>
      )}

      <div aria-live="polite" className="sr-only">
        {activeText}
      </div>

      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="flex items-center gap-1">
          <span className={`inline-block h-0.5 w-4 ${trendUp ? "bg-emerald-400" : "bg-red-400"}`} /> Equity
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 border-t border-dashed border-slate-400" /> Zeitraumstart
        </span>
        {compare && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-4 border-t border-dotted border-sky-400" /> {compare.label}
          </span>
        )}
        {benchmark && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-slate-300" /> {benchmark.label}
          </span>
        )}
        {showTrades && (
          <>
            <span className="flex items-center gap-1">
              <span className="inline-block h-0 w-0 border-x-4 border-b-[6px] border-x-transparent border-b-emerald-300" />
              Einstieg
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-sky-300" /> Ausstieg
            </span>
          </>
        )}
        {showDrawdown && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 border-b-2 border-red-400 bg-red-500/20" /> Drawdown (unter Wasser)
          </span>
        )}
        {maxDrawdown && maxDrawdown.pct > 0 && maxDrawdown.fromTs && (
          <span className="text-red-300/80">
            Max. Drawdown {formatPct(-maxDrawdown.pct)} markiert (Peak → Tief)
          </span>
        )}
      </figcaption>
    </figure>
  );
}
