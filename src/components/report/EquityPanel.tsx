"use client";

/**
 * Reports → Equity-Kurve: Zeitraumwahl, Kennzahlen, Chart, Vergleich, Export.
 *
 * Zweck: Die Kurve war vorher eine nackte SVG-Linie ohne Achsen, ohne
 * Drawdown und mit „Heute / Woche / Monat“ als einzigem Zoom. Dieses Panel
 * bringt die vollständige Sicht:
 *
 *   - Zeiträume 1 T · 1 W · 1 M · 3 M · 6 M · 1 J · Max (Berliner
 *     Kalendergrenzen, nicht rollende Stunden),
 *   - Kennzahlen inkl. **Drawdown Peak-to-Trough** (maximal, aktuell,
 *     Dauer, Erholung), Rendite, **zeitgewichteter Rendite (TWR)** gegen die
 *     einfache Rendite, Hoch/Tief, Tagesvolatilität,
 *   - **linear/logarithmische y-Achse** (gleicher prozentualer Abstand),
 *   - **Vergleich**: Referenzwert (Benchmark aus echten Kursdaten) und/oder
 *     der vorherige Zeitraum bzw. das Mittel der letzten drei Zeiträume,
 *   - **Drawdown-Episoden** (Top 5 mit Dauer und Erholungszeit),
 *   - **Monatsrendite-Heatmap** über die gesamte Historie,
 *   - Hover-/Tastatur-Tooltip je Kurvenpunkt, Trade-Marker, CSV-Export,
 *   - **Druck-/PDF-Ansicht** (heller Druck, Seitenumbrüche, Kopfzeile),
 *   - ehrliche Datenlage: Aufbewahrungsfenster, Auflösung, Aktualisierungszeit,
 *     Lade-/Fehler-/Leerzustände.
 *
 * Datenquelle: `GET /api/firm/equity` (siehe docs/EQUITY_CURVE.md). Die
 * Berechnung der Kennzahlen liegt serverseitig in `src/lib/equityAnalytics.ts`
 * — hier wird nichts nachgerechnet, damit UI und API dieselben Zahlen zeigen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import InfoTip from "@/components/workshop/InfoTip";
import EquityCurveChart, { type ComparisonSeries } from "./EquityCurveChart";
import {
  EQUITY_RANGE_LABELS,
  EQUITY_RANGE_TITLES,
  EQUITY_RANGES,
  type EquityRange,
} from "@/lib/equityRange";
import {
  formatMoney,
  formatPct,
  formatTimestamp,
  monthlySummary,
  type DrawdownEpisode,
  type EquityCurvePoint,
  type EquityMarker,
  type EquityStats,
  type MonthlyReturn,
  type TimeWeightedReturn,
} from "@/lib/equityAnalytics";
// Katalog statt Lese-Schicht: das Panel ist eine Client-Komponente und darf
// keinen `node:fs`-Import (`HistoricalStore`) ins Browser-Bundle ziehen.
import {
  BENCHMARK_IDS,
  BENCHMARKS,
  type BenchmarkId,
} from "@/lib/equityBenchmarkCatalog";

type EquityResponse = {
  ok: boolean;
  range: EquityRange;
  since: string;
  until: string;
  calendarSince: string;
  resolution: string;
  bucketSeconds: number;
  series: EquityCurvePoint[];
  markers: EquityMarker[];
  stats: EquityStats;
  episodes: DrawdownEpisode[];
  monthly: MonthlyReturn[];
  twr: TimeWeightedReturn;
  benchmark: {
    id: BenchmarkId;
    label: string;
    source: string;
    timeframe: string;
    points: Array<{ ts: string; value: number }>;
    returnPct: number | null;
  } | null;
  startingEquity: number;
  retention: {
    rawDays: number;
    retentionDays: number;
    historyStart: string | null;
    priorPeak: number | null;
    priorTs: string | null;
    truncated: boolean;
  };
  error?: string;
};

const REFRESH_MS = 60_000;

/** Vergleichsmodus: aus / Vorperiode / Mittel der letzten drei Perioden. */
type CompareMode = "off" | "previous" | "last3";

const MONTH_LABELS = [
  "Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
  "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
];

/** Farbe einer Monatsrendite (rot → neutral → grün), abgestuft nach Stärke. */
function heatColor(pct: number): string {
  const capped = Math.max(-10, Math.min(10, pct));
  if (Math.abs(capped) < 0.05) return "rgb(100 116 139 / 0.35)"; // slate-500
  const strength = 0.15 + (Math.abs(capped) / 10) * 0.6;
  return capped > 0
    ? `rgb(16 185 129 / ${strength.toFixed(2)})` // emerald-500
    : `rgb(239 68 68 / ${strength.toFixed(2)})`; // red-500
}

function heatTextColor(pct: number): string {
  return Math.abs(pct) >= 4 ? "text-slate-950" : "text-slate-100";
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  const days = hours / 24;
  if (days < 60) return `${days.toFixed(days < 10 ? 1 : 0)} T`;
  const months = days / 30.44;
  if (months < 24) return `${months.toFixed(1)} Mon`;
  return `${(days / 365).toFixed(1)} J`;
}

/**
 * Baut die Vergleichslinie aus früheren Zeiträumen: jede Periode wird auf den
 * Startpunkt des aktuellen Fensters **indexiert** und auf dessen Zeitachse
 * gelegt (Position relativ zum Fenster). Erst dadurch liegen „dieser Monat“ und
 * „letzter Monat“ übereinander, obwohl die Zeitstempel verschieden sind.
 */
function buildComparisonSeries(
  windows: Array<{ since: string; until: string; series: EquityCurvePoint[] }>,
  current: { since: string; until: string; firstEquity: number },
  label: string
): ComparisonSeries | null {
  const usable = windows.filter((w) => w.series.length >= 2);
  if (usable.length === 0) return null;

  const currentStart = Date.parse(current.since);
  const currentEnd = Date.parse(current.until);
  const currentSpan = Math.max(1, currentEnd - currentStart);

  // Relative Position → Mittelwert der indexierten Werte aller Perioden.
  const keyed = usable.map((w) => {
    const start = Date.parse(w.since);
    const span = Math.max(1, Date.parse(w.until) - start);
    const base = w.series[0].equity;
    return w.series.map((p, index) => {
      const fraction = Math.max(0, Math.min(1, (Date.parse(p.ts) - start) / span));
      const indexed = base > 0 ? p.equity / base : 1;
      return { fraction, indexed, index };
    });
  });

  const sampleCount = Math.min(240, Math.max(...keyed.map((k) => k.length)));
  const points: Array<{ ts: string; value: number }> = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const target = i / (sampleCount - 1 || 1);
    let sum = 0;
    let count = 0;
    for (const series of keyed) {
      let best = series[0];
      let bestDelta = Math.abs(series[0].fraction - target);
      for (const candidate of series) {
        const delta = Math.abs(candidate.fraction - target);
        if (delta < bestDelta) {
          best = candidate;
          bestDelta = delta;
        }
      }
      sum += best.indexed;
      count += 1;
    }
    if (count === 0) continue;
    points.push({
      ts: new Date(currentStart + target * currentSpan).toISOString(),
      value: (sum / count) * (current.firstEquity > 0 ? current.firstEquity : 1),
    });
  }
  return points.length >= 2 ? { label, points } : null;
}

export default function EquityPanel() {
  const [range, setRange] = useState<EquityRange>("month");
  const [mode, setMode] = useState<"absolute" | "percent">("absolute");
  const [logScale, setLogScale] = useState(false);
  const [showDrawdown, setShowDrawdown] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  const [benchmarkId, setBenchmarkId] = useState<BenchmarkId | "off">("off");
  const [compareMode, setCompareMode] = useState<CompareMode>("off");
  const [compareWindows, setCompareWindows] = useState<
    Array<{ since: string; until: string; series: EquityCurvePoint[] }>
  >([]);
  const [data, setData] = useState<EquityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const aliveRef = useRef(true);

  const load = useCallback(
    async (
      target: EquityRange = range,
      opts: { quiet?: boolean; benchmark?: BenchmarkId | "off" } = {}
    ) => {
      const wantedBenchmark = opts.benchmark ?? benchmarkId;
      if (!opts.quiet) setLoading(true);
      try {
        const query = new URLSearchParams({ range: target, resolution: "auto" });
        if (wantedBenchmark !== "off") query.set("compare", wantedBenchmark);
        const res = await fetch(`/api/firm/equity?${query.toString()}`, { cache: "no-store" });
        const json = (await res.json()) as EquityResponse & { error?: string };
        if (!aliveRef.current) return;
        if (!res.ok || json.ok === false) {
          setError(
            res.status === 401
              ? "Nicht angemeldet — bitte die Sitzung im Kopfbereich des Dashboards erneuern."
              : `Kurve konnte nicht geladen werden (${res.status}): ${json.error ?? "unbekannter Fehler"}`
          );
          return;
        }
        setData(json);
        setError(null);
        setUpdatedAt(new Date());
      } catch (e) {
        if (!aliveRef.current) return;
        setError(`Netzwerkfehler beim Laden der Kurve: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (aliveRef.current) setLoading(false);
      }
    },
    [range, benchmarkId]
  );

  useEffect(() => {
    aliveRef.current = true;
    const id = window.setTimeout(() => void load(range), 0);
    return () => {
      aliveRef.current = false;
      window.clearTimeout(id);
    };
  }, [load, range]);

  useEffect(() => {
    const id = window.setInterval(() => void load(range, { quiet: true }), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load, range]);

  // Vorperioden laden (nur wenn der Vergleich aktiv ist). Bewusst getrennt vom
  // Haupt-Load: der Vergleich ist eine Zusatzsicht, kein Muss für die Kurve.
  useEffect(() => {
    let alive = true;
    // Bewusst asynchron gebootet (kein synchrones setState im Effect): auch
    // das Zurücksetzen läuft über den Timer.
    const t = setTimeout(async () => {
      try {
        if (compareMode === "off" || !data || data.series.length < 2) {
          if (alive) setCompareWindows([]);
          return;
        }
        const count = compareMode === "last3" ? 3 : 1;
        const currentStart = Date.parse(data.since);
        const currentUntil = Date.parse(data.until);
        const span = Math.max(1, currentUntil - currentStart);
        const windows = Array.from({ length: count }, (_, i) => {
          const until = currentStart - i * span;
          return { since: until - span, until };
        });
        const results = await Promise.all(
          windows.map(async (w) => {
            const query = new URLSearchParams({
              range: data.range,
              resolution: "auto",
              from: new Date(w.since).toISOString(),
              until: new Date(w.until).toISOString(),
            });
            const res = await fetch(`/api/firm/equity?${query.toString()}`, { cache: "no-store" });
            const json = (await res.json()) as EquityResponse;
            return { since: json.since ?? new Date(w.since).toISOString(), until: json.until ?? new Date(w.until).toISOString(), series: json.series ?? [] };
          })
        );
        if (!alive) return;
        setCompareWindows(results);
      } catch {
        if (alive) setCompareWindows([]);
      }
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [compareMode, data]);

  const stats = data?.stats;
  const points = data?.series ?? [];
  const episodes = data?.episodes ?? [];
  const monthly = useMemo(() => data?.monthly ?? [], [data]);
  const monthsByYear = useMemo(() => {
    const map = new Map<number, Map<number, MonthlyReturn>>();
    for (const m of monthly) {
      const year = map.get(m.year) ?? new Map<number, MonthlyReturn>();
      year.set(m.month, m);
      map.set(m.year, year);
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0]); // neuestes Jahr zuerst
  }, [monthly]);
  const monthSummary = useMemo(() => monthlySummary(monthly), [monthly]);
  const markerCount = useMemo(
    () => (data?.markers ?? []).filter((m) => m.kind === "EXIT").length,
    [data]
  );

  const benchmarkSeries: ComparisonSeries | null = useMemo(() => {
    if (!data?.benchmark || data.benchmark.points.length < 2) return null;
    return {
      label: data.benchmark.label,
      points: data.benchmark.points,
      returnPct: data.benchmark.returnPct,
    };
  }, [data]);

  const compareSeries: ComparisonSeries | null = useMemo(() => {
    if (!data || compareMode === "off" || compareWindows.length === 0) return null;
    return buildComparisonSeries(
      compareWindows,
      { since: data.since, until: data.until, firstEquity: data.series[0]?.equity ?? 0 },
      compareMode === "last3" ? "Ø letzte 3 Zeiträume" : "Vorperiode"
    );
  }, [data, compareMode, compareWindows]);

  const downloadCsv = useCallback(() => {
    if (!data || data.series.length === 0) return;
    const hasBenchmark = (data.benchmark?.points.length ?? 0) > 1;
    const header = `Zeitstempel;Equity;Höchststand;Drawdown_%;Trigger${hasBenchmark ? ";Referenz" : ""}`;
    const benchmarkByTs = new Map((data.benchmark?.points ?? []).map((p) => [p.ts, p.value]));
    const rows = data.series.map((p) => {
      const cells = [
        p.ts,
        p.equity.toFixed(2),
        (p.peak ?? p.equity).toFixed(2),
        (p.drawdownPct ?? 0).toFixed(3),
        p.trigger ?? "",
      ];
      if (hasBenchmark) cells.push((benchmarkByTs.get(p.ts) ?? Number.NaN).toFixed?.(2) ?? "");
      return cells.join(";");
    });
    const csv = [header, ...rows].join("\r\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `equity-${data.range}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data]);

  const truncatedHint =
    data?.retention.truncated && data.retention.historyStart
      ? `Der Zeitraum reicht weiter zurück als die Historie — die Kurve beginnt am ${formatTimestamp(
          data.retention.historyStart
        )}.`
      : null;

  const excerpt = (value: string | null | undefined) => (value ? formatTimestamp(value) : "—");

  return (
    <section className="space-y-4">
      {/* ── Druckkopf (nur im Druck sichtbar) ───────────────────────────── */}
      <div className="hidden border-b border-black pb-2 print:block">
        <p className="text-lg font-bold">Equity-Report · Autonome KI-Trading-Firma</p>
        <p className="text-xs">
          Stand {data ? formatTimestamp(data.until, { withSeconds: true }) : "—"} · Zeitraum{" "}
          {EQUITY_RANGE_LABELS[range]} (ab {excerpt(data?.since)}) · Auflösung {data?.resolution ?? "—"}
        </p>
        <p className="mt-1 text-xs">
          Rendite {stats?.returnPct != null ? formatPct(stats.returnPct) : "—"} · TWR{" "}
          {data?.twr.twrPct != null ? formatPct(data.twr.twrPct) : "—"} · max. Drawdown {stats ? formatPct(-stats.maxDrawdownPct) : "—"} ·
          aktueller Drawdown {stats ? formatPct(-stats.currentDrawdownPct) : "—"} · Trades {markerCount}
          {data?.benchmark ? ` · Referenz ${data.benchmark.label} ${data.benchmark.returnPct != null ? formatPct(data.benchmark.returnPct) : ""}` : ""}
        </p>
      </div>

      {/* ── Kopfzeile: Zeiträume + Aktionen ─────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <h2 className="mr-1 text-sm font-semibold uppercase tracking-wider text-slate-400">
          📈 Equity-Kurve
        </h2>
        <InfoTip
          label="Equity-Kurve"
          text="Kontostand über die Zeit (Cash + Marktwert offener Positionen). Ein Punkt je Monitor-Tick (60 s) bzw. Trade; ältere Daten werden zu Tagesständen verdichtet (Tief + Tagesschluss)."
        />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Zeitraum der Equity-Kurve">
          {EQUITY_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              title={EQUITY_RANGE_TITLES[r]}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                range === r
                  ? "bg-emerald-500 text-slate-950"
                  : "border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {EQUITY_RANGE_LABELS[r]}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-500">
          {updatedAt && <span title="Letzte erfolgreiche Aktualisierung">Stand {updatedAt.toLocaleTimeString("de-DE")}</span>}
          <button
            type="button"
            onClick={() => void load(range)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 font-semibold text-slate-300 hover:bg-slate-700"
            title="Kurve jetzt neu laden (automatisch alle 60 s)"
          >
            ⟳ Aktualisieren
          </button>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={!data || data.series.length === 0}
            className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 font-semibold text-slate-300 hover:bg-slate-700 disabled:opacity-40"
            title="Kurvenpunkte als CSV exportieren (Semikolon-getrennt, Excel-freundlich)"
          >
            ⭳ CSV
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 font-semibold text-slate-300 hover:bg-slate-700"
            title="Druck-/PDF-Ansicht: heller Druck ohne Bedienelemente, mit Report-Kopf und Seitenumbrüchen"
          >
            🖨 Druck / PDF
          </button>
        </div>
      </div>

      {/* ── Kennzahlen ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4">
        <Metric
          label="Rendite im Zeitraum"
          value={stats?.returnPct != null ? formatPct(stats.returnPct) : "—"}
          tone={stats?.returnPct != null && stats.returnPct >= 0 ? "good" : stats?.returnPct != null ? "bad" : undefined}
          hint="(letzter Punkt − erster Punkt) / erster Punkt des gewählten Zeitraums. Nicht mit dem Startkapital verwechseln — das steht in der Kachel „vs. Startkapital“."
        />
        <Metric
          label="TWR (zeitgewichtet)"
          value={data?.twr.twrPct != null ? formatPct(data.twr.twrPct) : "—"}
          tone={data?.twr.twrPct != null && data.twr.twrPct >= 0 ? "good" : data?.twr.twrPct != null ? "bad" : undefined}
          hint={
            "Zeitgewichtete Rendite: die Tagesrenditen werden verkettet (Π(1+r) − 1), nicht als Endpunkt-Differenz. " +
            "Damit verzerrt ein zwischenzeitlicher Kapitalzufluss die Kennzahl nicht — vorausgesetzt, er ist bekannt. " +
            "Das Paper-Konto führt noch keine Cashflow-Spur; solange entspricht sie der Kettenrendite ohne Bereinigung."
          }
          sub={
            data?.twr.simplePct != null
              ? `einfach ${formatPct(data.twr.simplePct)} · ${data.twr.days} Tage${data.twr.flows.applied ? " · cashflow-bereinigt" : " · ohne Cashflow-Bereinigung"}`
              : undefined
          }
        />
        <Metric
          label="Referenz im Vergleich"
          value={data?.benchmark?.returnPct != null ? formatPct(data.benchmark.returnPct) : "—"}
          tone={
            data?.benchmark?.returnPct != null && stats?.returnPct != null
              ? data.benchmark.returnPct >= (stats.returnPct ?? 0)
                ? "bad"
                : "good"
              : undefined
          }
          hint="Buy-and-Hold der gewählten Referenz über dasselbe Fenster, mit dem Kontostand des Fensterstarts. Grün heißt: die Firma war besser als die Referenz."
          sub={
            data?.benchmark
              ? `${data.benchmark.label} · ${data.benchmark.source} (${data.benchmark.timeframe})`
              : "keine Referenzdaten — npm run market-sync füllt data/history"
          }
        />
        <Metric
          label="vs. Startkapital"
          value={stats?.vsStartPct != null ? formatPct(stats.vsStartPct) : "—"}
          tone={stats?.vsStartPct != null && stats.vsStartPct >= 0 ? "good" : stats?.vsStartPct != null ? "bad" : undefined}
          hint="Abstand des letzten Kurvenpunkts zum festen Startkapital (STARTING_EQUITY). Bewusst getrennt von der Rendite im Zeitraum: ein Konto kann im Zeitraum gewinnen und trotzdem unter dem Startkapital liegen."
          sub={stats?.startEquity != null ? `Start ${formatMoney(stats.startEquity)}` : undefined}
        />
        <Metric
          label="Max. Drawdown"
          value={stats ? formatPct(-stats.maxDrawdownPct) : "—"}
          tone={stats && stats.maxDrawdownPct > 0 ? "bad" : undefined}
          hint="Größter Rückgang vom bisherigen Höchststand (Peak-to-Trough) innerhalb des Zeitraums, in Prozent dieses Höchststands. Der Höchststand aus der Zeit VOR dem Zeitraum zählt mit."
          sub={
            stats?.maxDrawdownFrom && stats?.maxDrawdownTo
              ? `${formatTimestamp(stats.maxDrawdownFrom)} → ${formatTimestamp(stats.maxDrawdownTo)}`
              : "kein Rückgang im Zeitraum"
          }
        />
        <Metric
          label="Aktueller Drawdown"
          value={stats ? formatPct(-stats.currentDrawdownPct) : "—"}
          tone={stats && stats.currentDrawdownPct > 0 ? "bad" : "good"}
          hint="Abstand des letzten Punktes zum laufenden Höchststand (High-Water-Mark). 0 % heißt: das Konto steht auf oder über seinem Hoch."
          sub={stats?.recoveredAt ? `erholt am ${formatTimestamp(stats.recoveredAt)}` : stats && stats.maxDrawdownPct > 0 ? "noch nicht erholt" : undefined}
        />
        <Metric
          label="Hoch / Tief"
          value={stats?.peakEquity != null && stats?.lowEquity != null ? `${formatMoney(stats.peakEquity)} / ${formatMoney(stats.lowEquity)}` : "—"}
          hint="Höchster und tiefster Kontostand im Zeitraum (aus den Snapshots, nicht aus Tagesschlusskursen)."
        />
        <Metric
          label="Tagesvolatilität"
          value={stats?.volatilityPct != null ? `${stats.volatilityPct.toFixed(2)} %` : "—"}
          hint="Standardabweichung der Tagesrenditen (Berliner Kalendertage). Ein Rauschmaß — kein Qualitätsurteil."
          sub={stats?.sharpeLike != null ? `Sharpe-ähnlich ${stats.sharpeLike.toFixed(2)}` : "Sharpe erst ab 5 Tagen"}
        />
      </div>

      {truncatedHint && (
        <p className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          {truncatedHint} Aufbewahrung: {data?.retention.retentionDays} Tage gesamt, davon{" "}
          {data?.retention.rawDays} Tage in Rohauflösung.
        </p>
      )}

      {/* ── Optionen ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400 print:hidden">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showDrawdown}
            onChange={(e) => setShowDrawdown(e.target.checked)}
            className="h-3.5 w-3.5 accent-emerald-500"
          />
          Drawdown-Kurve
          <InfoTip
            label="Drawdown-Kurve"
            text="Unterwasser-Kurve: wie weit der Kontostand unter seinem bisherigen Höchststand liegt (in Prozent). Sie beginnt jedes Mal bei 0 %, wenn ein neues Hoch erreicht wird."
          />
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showTrades}
            onChange={(e) => setShowTrades(e.target.checked)}
            className="h-3.5 w-3.5 accent-emerald-500"
          />
          Trade-Marker
          <InfoTip
            label="Trade-Marker"
            text="▲ = Einstieg, ● = Ausstieg (blau = Gewinn, rot = Verlust). Bei mehr als 80 Trades werden der Übersicht wegen nur Ausstiege gezeichnet."
          />
        </label>
        <div className="flex items-center gap-1.5">
          <span>Y-Achse:</span>
          <button
            type="button"
            aria-pressed={mode === "absolute"}
            onClick={() => setMode("absolute")}
            className={`rounded-md px-2 py-1 font-semibold ${mode === "absolute" ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
            title="Kontostand in USD"
          >
            USD
          </button>
          <button
            type="button"
            aria-pressed={mode === "percent"}
            onClick={() => setMode("percent")}
            className={`rounded-md px-2 py-1 font-semibold ${mode === "percent" ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
            title="Indexdarstellung: erster Punkt des Zeitraums = 100 (vergleicht Zeiträume unabhängig vom Kontostand)"
          >
            Index (Start = 100)
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span>Skala:</span>
          <button
            type="button"
            aria-pressed={!logScale}
            onClick={() => setLogScale(false)}
            className={`rounded-md px-2 py-1 font-semibold ${!logScale ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
            title="Lineare Achse: gleiche absolute Abstände (z. B. 500 USD je Rasterlinie)"
          >
            linear
          </button>
          <button
            type="button"
            aria-pressed={logScale}
            onClick={() => setLogScale(true)}
            className={`rounded-md px-2 py-1 font-semibold ${logScale ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
            title="Logarithmische Achse: gleiche prozentuale Abstände — sinnvoll, wenn der Kontostand über Größenordnungen wächst. Bei Werten ≤ 0 bleibt es automatisch linear."
          >
            log
          </button>
          <InfoTip
            label="Logarithmische Achse"
            text="Auf einer log-Achse bedeutet derselbe Abstand denselben prozentualen Zuwachs. Ein Anstieg von 1.000 auf 2.000 sieht dann genauso groß aus wie 10.000 auf 20.000. Die Rasterlinien folgen dem 1/2/5-Raster der Zehnerpotenzen."
          />
        </div>
        <label className="flex items-center gap-1.5">
          <span>Referenz:</span>
          <select
            value={benchmarkId}
            onChange={(e) => setBenchmarkId(e.target.value as BenchmarkId | "off")}
            className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 font-semibold text-slate-200"
            title="Vergleichslinie aus echten Kursdaten (data/history), skaliert auf den Kontostand des Fensterstarts"
          >
            <option value="off">keine</option>
            {BENCHMARK_IDS.map((id) => (
              <option key={id} value={id}>
                {BENCHMARKS[id].label}
              </option>
            ))}
          </select>
          <InfoTip
            label="Referenzwert"
            text="Buy-and-Hold der Referenz über dasselbe Fenster, mit dem Kontostand des Fensterstarts. Die Daten kommen aus der echten Kerzen-Historie (data/history, gefüllt durch npm run market-sync) — es wird nichts geschätzt oder erfunden. Ohne Historie bleibt die Linie weg."
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span>Vergleich:</span>
          <select
            value={compareMode}
            onChange={(e) => setCompareMode(e.target.value as CompareMode)}
            className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 font-semibold text-slate-200"
            title="Frühere Zeiträume auf denselben Startpunkt indexieren und über die aktuelle Zeitachse legen"
          >
            <option value="off">aus</option>
            <option value="previous">Vorperiode</option>
            <option value="last3">Ø letzte 3 Perioden</option>
          </select>
          {compareMode !== "off" && (
            <span className="text-[11px] text-slate-500">
              {compareSeries ? "indexiert auf den Start" : compareWindows.length === 0 ? "lade Vorperioden…" : "keine Daten"}
            </span>
          )}
        </label>
      </div>

      {/* ── Chart ───────────────────────────────────────────────────────── */}
      {loading && points.length === 0 ? (
        <div className="flex h-48 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/50 text-sm text-slate-400">
          Lade Kurve…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-700/50 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void load(range)}
            className="mt-2 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-1 text-xs font-semibold hover:bg-red-500/20"
          >
            Erneut versuchen
          </button>
        </div>
      ) : (
        <EquityCurveChart
          points={points}
          markers={data?.markers ?? []}
          mode={mode}
          logScale={logScale}
          showDrawdown={showDrawdown}
          showTrades={showTrades}
          benchmark={benchmarkSeries}
          compare={compareSeries}
          maxDrawdown={
            stats
              ? { fromTs: stats.maxDrawdownFrom, toTs: stats.maxDrawdownTo, pct: stats.maxDrawdownPct }
              : null
          }
        />
      )}

      {/* ── Drawdown-Episoden ───────────────────────────────────────────── */}
      {episodes.length > 0 && (
        <section className="print-break-avoid">
          <h3 className="mb-2 flex items-center text-sm font-semibold uppercase tracking-wider text-slate-400">
            Die fünf tiefsten Drawdown-Phasen
            <InfoTip
              label="Drawdown-Phasen"
              text="Jede Phase läuft vom Höchststand über das Tief bis zur Erholung (Rückkehr auf den Höchststand). „offen“ heißt: die Erholung steht noch aus — dann ist keine Erholungszeit bekannt und die Gesamtdauer läuft bis zum letzten Kurvenpunkt."
            />
          </h3>
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/70 text-[11px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-semibold">#</th>
                  <th className="px-3 py-2 font-semibold">Rückgang</th>
                  <th className="px-3 py-2 font-semibold">Höchststand → Tief</th>
                  <th className="px-3 py-2 font-semibold">Absolut</th>
                  <th className="px-3 py-2 font-semibold">Abstieg</th>
                  <th className="px-3 py-2 font-semibold">Erholung</th>
                  <th className="px-3 py-2 font-semibold">Gesamt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-300">
                {episodes.map((episode, index) => (
                  <tr key={`${episode.troughTs}-${index}`} className="hover:bg-slate-900/40">
                    <td className="px-3 py-2 text-slate-500">{index + 1}</td>
                    <td className="px-3 py-2 font-semibold text-red-300">{formatPct(-episode.drawdownPct)}</td>
                    <td className="px-3 py-2">
                      {episode.peakTs ? formatTimestamp(episode.peakTs) : "vor dem Zeitraum"}{" "}
                      <span className="text-slate-500">→</span> {formatTimestamp(episode.troughTs)}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums">{formatMoney(-episode.drawdownAbs)}</td>
                    <td className="px-3 py-2">{formatDuration(episode.declineMs)}</td>
                    <td className="px-3 py-2">
                      {episode.recoveredAt ? (
                        <>
                          {formatDuration(episode.recoveryMs)}{" "}
                          <span className="text-slate-500">bis {formatTimestamp(episode.recoveredAt)}</span>
                        </>
                      ) : (
                        <span className="text-amber-300">offen</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{formatDuration(episode.totalMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Monatsrendite-Heatmap ───────────────────────────────────────── */}
      {monthly.length > 0 && (
        <section className="print-break-avoid">
          <h3 className="mb-2 flex items-center text-sm font-semibold uppercase tracking-wider text-slate-400">
            Monatsrenditen (Berliner Kalendermonate)
            <InfoTip
              label="Monatsrenditen"
              text="Rendite je Kalendermonat aus dem ersten und letzten Snapshot des Monats (aus der Tabelle, nicht aus der verdichteten Chart-Kurve). Der erste und der letzte Monat sind oft angeschnitten und mit * markiert. Die Farbintensität entspricht der Stärke zwischen −10 % und +10 %."
            />
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-separate border-spacing-1 text-left text-[11px]">
              <thead>
                <tr className="text-slate-500">
                  <th className="w-12 font-semibold">Jahr</th>
                  {MONTH_LABELS.map((label) => (
                    <th key={label} className="text-center font-semibold">
                      {label}
                    </th>
                  ))}
                  <th className="text-center font-semibold">Jahr</th>
                </tr>
              </thead>
              <tbody>
                {monthsByYear.map(([year, months]) => {
                  // Jahresrendite: verkettete Monatsrenditen des Jahres —
                  // nicht die Summe (Zinseszins) und nicht der Abstand zum
                  // Jahresstart, der bei angeschnittenem Januar fehlte.
                  const compounded =
                    [...months.values()].reduce((acc, m) => acc * (1 + m.pct / 100), 1) * 100 - 100;
                  return (
                    <tr key={year}>
                      <td className="font-semibold text-slate-400">{year}</td>
                      {MONTH_LABELS.map((_, index) => {
                        const month = months.get(index + 1);
                        if (!month) {
                          return <td key={index} className="h-7 rounded border border-slate-800/60 bg-slate-900/30" />;
                        }
                        return (
                          <td
                            key={index}
                            className={`h-7 rounded text-center font-mono tabular-nums ${heatTextColor(month.pct)}`}
                            style={{ backgroundColor: heatColor(month.pct) }}
                            title={`${MONTH_LABELS[index]} ${year}: ${formatPct(month.pct)}${month.partial ? " (angeschnitten)" : ""} · ${month.points} Punkte`}
                          >
                            {month.pct > 0 ? "+" : month.pct < 0 ? "−" : ""}
                            {Math.abs(month.pct).toFixed(1)}
                            {month.partial ? "*" : ""}
                          </td>
                        );
                      })}
                      <td
                        className={`h-7 rounded text-center font-mono font-semibold tabular-nums ${heatTextColor(compounded)}`}
                        style={{ backgroundColor: heatColor(compounded) }}
                        title={`${year}: ${formatPct(compounded)} (verkettete Monatsrenditen)`}
                      >
                        {compounded > 0 ? "+" : compounded < 0 ? "−" : ""}
                        {Math.abs(compounded).toFixed(1)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            {monthSummary.months} Monate · {monthSummary.positive} positiv / {monthSummary.negative} negativ
            {monthSummary.best ? ` · bester ${monthSummary.best.ym} ${formatPct(monthSummary.best.pct)}` : ""}
            {monthSummary.worst ? ` · schwächster ${monthSummary.worst.ym} ${formatPct(monthSummary.worst.pct)}` : ""}
            {" · * = angeschnittener Monat; Jahr-Spalte = verkettete Monatsrenditen."}
          </p>
        </section>
      )}

      {/* ── Fußnote: Definitionen + Datenlage ───────────────────────────── */}
      <p className="text-[11px] leading-relaxed text-slate-500">
        Equity = freies Cash + Marktwert offener Positionen. Drawdown = Rückgang vom bisherigen Höchststand
        (Peak-to-Trough), {data ? `Höchststand vor dem Zeitraum: ${data.retention.priorPeak != null ? formatMoney(data.retention.priorPeak) : "unbekannt"}` : "…"}.
        Startkapital {data ? formatMoney(data.startingEquity) : "—"} · Zeitzone Europe/Berlin ·{" "}
        {data?.retention.historyStart
          ? `Historie ab ${formatTimestamp(data.retention.historyStart)}`
          : "noch keine Historie"}
        . {data ? `Gelesen bis ${formatTimestamp(data.until, { withSeconds: true })}` : ""}
        {data?.benchmark ? ` · Referenz: ${data.benchmark.source} (${data.benchmark.timeframe}), auf den Fensterstart skaliert.` : ""}
      </p>
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
  sub,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  sub?: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="print-break-avoid rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
      <p className="flex items-center text-[11px] uppercase tracking-wider text-slate-400">
        {label}
        <InfoTip label={label} text={hint} />
      </p>
      <p
        className={`mt-1 text-base font-bold tabular-nums ${
          tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-slate-100"
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[10px] text-slate-500">{sub}</p>}
    </div>
  );
}
