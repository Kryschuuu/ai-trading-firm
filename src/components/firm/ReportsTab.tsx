"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiClient";
import { isReportData, type ReportData } from "@/lib/reportResponse";
import { describeAuditEntry } from "@/lib/auditView";
import EquityPanel from "../report/EquityPanel";
import InfoTip from "../ui/InfoTip";
import DataTable from "../ui/DataTable";
import MetricTile from "../ui/MetricTile";
import { AUTO_FIT_CARDS, PANEL, SECTION_TITLE } from "../ui/layout";

// ───────────────────────── Reports (Boss-Sicht) ─────────────────────────────

/** Zeiträume der Report-Kennzahlen (Berliner Kalendergrenzen, siehe @/lib/time). */
type PeriodId = "day" | "week" | "month" | "quarter" | "halfyear" | "year";

const PERIOD_OPTIONS: { id: PeriodId; label: string; title: string }[] = [
  { id: "day", label: "Heute", title: "Heutiger Berliner Kalendertag ab 00:00" },
  { id: "week", label: "Woche", title: "Diese Woche ab Montag 00:00 (Berliner Zeit)" },
  { id: "month", label: "Monat", title: "Dieser Monat ab dem 1. um 00:00 (Berliner Zeit)" },
  { id: "quarter", label: "Quartal", title: "Dieses Quartal ab 1. Jan/Apr/Jul/Okt" },
  { id: "halfyear", label: "Halbjahr", title: "Dieses Halbjahr ab 1. Januar bzw. 1. Juli" },
  { id: "year", label: "Jahr", title: "Dieses Kalenderjahr ab 1. Januar" },
];

/**
 * Reports-Tab (Führungssicht). Links die Kennzahlen des Zeitraums (aus
 * `GET /api/firm/report`), darunter das eigenständige Kurven-Panel
 * (`EquityPanel`) mit eigenem Zeitraum-Schalter, Drawdown-Verlauf,
 * Trade-Markern und Export.
 */
export default function ReportsTab({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const [period, setPeriod] = useState<PeriodId>("day");
  const [report, setReport] = useState<ReportData | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [loadingRep, setLoadingRep] = useState(true);

  useEffect(() => {
    let alive = true;
    // async booten (kein synchrones setState im Effect)
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/firm/report?period=${period}`, { cache: "no-store" });
        const json: unknown = await res.json().catch(() => null);
        if (!alive) return;

        if (res.status === 401) {
          onUnauthorized?.();
        }
        if (!res.ok) {
          const body = json && typeof json === "object" ? (json as { error?: unknown }) : null;
          const detail = typeof body?.error === "string" && body.error.trim().length > 0
            ? body.error.trim()
            : `HTTP ${res.status}`;
          setReport(null);
          setReportError(
            res.status === 401
              ? "Nicht angemeldet — bitte die Sitzung im Kopfbereich des Dashboards erneuern."
              : `Report konnte nicht geladen werden (${detail}).`
          );
          return;
        }
        if (!isReportData(json)) {
          // Fehlerantworten duerfen nie in den Report-State gelangen: Die
          // Darstellung mappt mehrere Listen und wuerde sonst z. B. mit
          // `undefined.length` abbrechen.
          setReport(null);
          setReportError("Unerwartete Antwort von GET /api/firm/report.");
          return;
        }
        setReport(json);
        setReportError(null);
      } catch {
        if (alive) {
          setReport(null);
          setReportError("Report konnte wegen eines Netzwerkfehlers nicht geladen werden.");
        }
      } finally {
        if (alive) setLoadingRep(false);
      }
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [onUnauthorized, period]);

  const k = report?.kpis;
  const pct = (v: number | null | undefined, digits = 2) =>
    v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)} %`;
  const money = (v: number | null | undefined) =>
    v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;
  // "fresh" kommt serverseitig aus der Report-API (kein Date.now() im Render).

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Kennzahlen-Zeitraum</span>
        {PERIOD_OPTIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.title}
            aria-pressed={period === p.id}
            onClick={() => setPeriod(p.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              period === p.id ? "bg-emerald-500 text-slate-950" : "border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {p.label}
          </button>
        ))}
        {report && (
          <span className="ml-auto self-center text-xs text-slate-500">
            ab {new Date(report.since).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} (Europe/Berlin)
          </span>
        )}
      </div>

      {reportError && (
        <p role="alert" className="rounded-xl border border-amber-700/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
          {reportError}
        </p>
      )}

      {/* Boss-Zusammenfassung */}
      {report && report.summary.length > 0 && (
        <section className="rounded-xl border border-emerald-700/40 bg-emerald-950/20 p-5">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-emerald-300">📌 Lagebild für die Führung</h2>
          <ul className="ml-4 list-disc space-y-1 text-sm text-emerald-50/90">
            {report.summary.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </section>
      )}

      {/* KPI-Kacheln: Ergebnis */}
      {k && (
        <section>
          <h2 className={`mb-2 ${SECTION_TITLE}`}>
            Ergebnis (abgeschlossene Trades)
            <InfoTip
              label="Ergebnis"
              text="Alle Kacheln dieser Zeile beziehen sich auf Trades, die im gewählten Zeitraum geschlossen wurden. Schwebende Positionen zählen erst nach dem Schließen."
            />
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 3xl:grid-cols-6">
            <MetricTile
              label="Trades"
              value={String(k.trades)}
              hint="Anzahl geschlossener Positionen im Zeitraum (nicht die offenen)."
              sub={k.avgHoldHours != null ? `Ø Haltedauer ${k.avgHoldHours.toFixed(1)} h` : undefined}
            />
            <MetricTile
              label="Realisiertes P&L"
              value={money(k.realizedPnl)}
              tone={k.realizedPnl > 0 ? "good" : k.realizedPnl < 0 ? "bad" : undefined}
              hint="Summe des realisierten Gewinns/Verlusts aller geschlossenen Trades im Zeitraum (Kontowährung, ohne schwebende Positionen)."
              sub={
                k.grossProfit != null && k.grossLoss != null
                  ? `Gewinne +${k.grossProfit.toFixed(2)} · Verluste −${k.grossLoss.toFixed(2)}`
                  : undefined
              }
            />
            <MetricTile
              label="Trefferquote"
              value={k.winRate != null ? `${k.winRate} %` : "—"}
              tone={k.winRate != null && k.winRate >= 50 ? "good" : k.winRate != null ? "bad" : undefined}
              hint="Anteil der Trades mit positivem realisiertem P&L. Eine hohe Trefferquote allein sagt nichts über die Profitabilität — dafür sind Profit-Faktor und Erwartungswert da."
              sub={k.trades > 0 ? `${Math.round((k.winRate ?? 0) / 100 * k.trades)} von ${k.trades} gewonnen` : undefined}
            />
            <MetricTile
              label="Profit-Faktor"
              value={k.profitFactor != null ? (k.profitFactor === Infinity ? "∞" : k.profitFactor.toFixed(2)) : "—"}
              tone={k.profitFactor != null && k.profitFactor >= 1.5 ? "good" : k.profitFactor != null && k.profitFactor < 1 ? "bad" : undefined}
              hint="Bruttogewinne ÷ Bruttoverluste. > 1 ist profitabel, < 1 verliert Geld; ∞ heißt: es gab keinen Verlusttrade."
            />
            <MetricTile
              label="Erwartungswert / Trade"
              value={money(k.expectancy ?? null)}
              tone={k.expectancy != null && k.expectancy > 0 ? "good" : k.expectancy != null && k.expectancy < 0 ? "bad" : undefined}
              hint="Durchschnittlicher Gewinn/Verlust je Trade. Die pragmatischste Kennzahl: positiv heißt, das System verdient pro Trade Geld."
              sub={k.payoffRatio != null ? `Gewinn/Verlust-Verhältnis ${k.payoffRatio.toFixed(2)}` : undefined}
            />
            <MetricTile
              label="Max. Drawdown"
              value={k.maxDrawdownPct != null ? `−${k.maxDrawdownPct.toFixed(2)} %` : "—"}
              tone={k.maxDrawdownPct > 10 ? "bad" : undefined}
              hint="Größter Rückgang des Kontostands vom bisherigen Höchststand (Peak-to-Trough) im Zeitraum — aus den Equity-Snapshots, nicht aus der P&L-Summe. Der Höchststand vor dem Zeitraum zählt mit."
              sub={
                k.maxDrawdownFrom && k.maxDrawdownTo
                  ? `${new Date(k.maxDrawdownFrom).toLocaleDateString("de-DE")} → ${new Date(k.maxDrawdownTo).toLocaleDateString("de-DE")}`
                  : "kein Rückgang im Zeitraum"
              }
            />
            <MetricTile
              label="Aktueller Drawdown"
              value={pct(-(k.currentDrawdownPct ?? 0))}
              tone={(k.currentDrawdownPct ?? 0) > 0 ? "bad" : "good"}
              hint="Abstand zum laufenden Höchststand (High-Water-Mark) am Ende des Zeitraums. 0 % = das Konto steht auf oder über seinem Hoch."
              sub={k.recoveredAt ? `erholt am ${new Date(k.recoveredAt).toLocaleDateString("de-DE")}` : (k.maxDrawdownPct ?? 0) > 0 ? "noch nicht erholt" : undefined}
            />
            <MetricTile
              label="Serien"
              value={`${k.maxWinStreak ?? 0} / ${k.maxLossStreak ?? 0}`}
              hint="Längste Gewinnserie / längste Verlustserie in Trades. Verlustserien sind der Realitätstest für die Nerven — und für den Circuit-Breaker."
              sub="Gewinne / Verluste in Folge"
            />
            <MetricTile
              label="Stops ausgelöst"
              value={String(k.stopLossHits)}
              tone={k.stopLossHits > 0 ? "bad" : undefined}
              hint="Trades, die über den Stop-Loss beendet wurden. Viele Stops ohne Take-Profits deuten auf zu enge Stops oder ein unpassendes Regime."
            />
            <MetricTile
              label="TPs erreicht"
              value={String(k.takeProfitHits)}
              tone={k.takeProfitHits > 0 ? "good" : undefined}
              hint="Trades, die über das Take-Profit-Ziel beendet wurden."
            />
            <MetricTile
              label="Bester / schwächster Trade"
              value={
                k.bestTrade && k.worstTrade
                  ? `${money(k.bestTrade.pnl)} / ${money(k.worstTrade.pnl)}`
                  : "—"
              }
              hint="Größter Einzelgewinn und größter Einzelverlust im Zeitraum (Symbol in der Unterzeile)."
              sub={
                k.bestTrade && k.worstTrade
                  ? `${k.bestTrade.symbol} · ${k.worstTrade.symbol}`
                  : undefined
              }
            />
          </div>
        </section>
      )}

      {/* Equity-Kurve: eigenes Panel mit Zeiträumen, Drawdown, Markern, Export */}
      <EquityPanel />

      {loadingRep && !report && (
        <p className="text-sm text-slate-400">Lade Report-Kennzahlen…</p>
      )}

      {/* Empfehlungen des Hauses */}
      {report && report.recommendations.length > 0 && (
        <section>
          <h2 className={`mb-2 ${SECTION_TITLE}`}>
            💡 Empfehlungen des Hauses
          </h2>
          <div className={AUTO_FIT_CARDS}>
            {(report?.recommendations ?? []).map((r, i) => {
              return (
                <div key={i} className={`${PANEL} p-4`}>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-100">{r.symbol}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                      r.side === "LONG" ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
                    }`}>
                      {r.side}
                    </span>
                    {r.horizon && <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[11px] text-sky-300">{r.horizon}</span>}
                    {!r.fresh && <span className="text-[11px] text-amber-400">⚠️ älter als 24 h</span>}
                    <span className="ml-auto text-xs text-slate-500">{r.role}</span>
                  </div>
                  {r.thesis && <p className="mt-1 text-xs text-slate-300">{r.thesis}</p>}
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
                    {r.entryZone && <span>Einstieg: <b className="text-slate-200">{r.entryZone}</b></span>}
                    {r.stopLoss && <span>Stop: <b className="text-red-300">{r.stopLoss}</b></span>}
                    {r.target && <span>Ziel: <b className="text-emerald-300">{r.target}</b></span>}
                    {typeof r.confidence === "number" && <span>Konfidenz: {(r.confidence * 100).toFixed(0)} %</span>}
                  </div>
                  {r.riskFlags && r.riskFlags.length > 0 && (
                    <p className="mt-1 text-xs text-amber-400">⚠️ Risiken: {r.riskFlags.join(", ")}</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Symbol-Breakdown + Blocks */}
      {report && (
        <section className="grid gap-6 xl:grid-cols-2">
          <div>
            <h2 className={`mb-2 ${SECTION_TITLE}`}>Pro Symbol</h2>
            <DataTable
              label="Ergebnis pro Symbol"
              head={["Symbol", "Trades", "Gewinner", "P&L"]}
              empty="Keine geschlossenen Trades im Zeitraum."
              rows={report.symbols.map((s) => [
                s.symbol,
                s.trades,
                `${s.wins}/${s.trades}`,
                <span key={s.symbol} className={(s.pnl >= 0 ? "text-emerald-400" : "text-red-400") + " font-semibold tabular-nums"}>
                  {(s.pnl >= 0 ? "+" : "") + s.pnl.toFixed(2)}
                </span>,
              ])}
            />
          </div>
          <div>
            <h2 className={`mb-2 ${SECTION_TITLE}`}>Blöcke & Gründe</h2>
            <DataTable
              label="Blockierte Orders und Gründe"
              head={["Grund", "Anzahl", "Bedeutung"]}
              empty="Keine blockierten Orders im Zeitraum."
              rows={report.blocks.map((b) => [
                <code key={b.reason} className="font-mono text-xs text-amber-300">{b.reason}</code>,
                b.count,
                b.explanation ?? "—",
              ])}
            />
          </div>
        </section>
      )}

      {/* Bemerkenswerte Ereignisse */}
      {report && report.notableEvents.length > 0 && (
        <section>
          <h2 className={`mb-2 ${SECTION_TITLE}`}>
            Wichtige Ereignisse (SL/TP, Kill-Switch, Konfiguration)
          </h2>
          <DataTable
            label="Wichtige Ereignisse im Zeitraum"
            head={["Zeit", "Ereignis", "Stufe", "Was ist passiert?"]}
            rows={report.notableEvents.map((e) => {
              // Derselbe Aufbereiter wie im Audit-Trail — keine abgeschnittene JSON.
              const view = describeAuditEntry({
                id: `${e.event}-${e.at}`,
                createdAt: e.at,
                event: e.event,
                level: e.level,
                detail: e.detail,
              });
              return [
                <span key={`${e.event}-${e.at}-at`} className="whitespace-nowrap tabular-nums">
                  {view.atLabel}
                </span>,
                <span key={`${e.event}-${e.at}-event`}>
                  <span className="block font-semibold text-slate-200">{view.eventLabel}</span>
                  <code className="text-xs text-slate-500">{e.event}</code>
                </span>,
                <span
                  key={`${e.event}-${e.at}-level`}
                  className={
                    view.tone === "critical"
                      ? "font-bold text-red-400"
                      : view.tone === "warn"
                        ? "text-amber-300"
                        : "text-emerald-300"
                  }
                >
                  {view.levelLabel}
                </span>,
                <details key={`${e.event}-${e.at}-detail`} className="max-w-xl">
                  <summary className="cursor-pointer text-slate-300">{view.headline}</summary>
                  <p className="mt-1 text-xs text-slate-400">{view.explanation}</p>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950/60 p-2 font-mono text-xs text-slate-300">
                    {view.raw}
                  </pre>
                </details>,
              ];
            })}
          />
        </section>
      )}
    </div>
  );
}
