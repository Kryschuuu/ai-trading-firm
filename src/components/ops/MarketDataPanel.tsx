/**
 * MarketDataPanel (OPS-011) — Sektion „Market Data“ **oberhalb** des
 * Scanner-Funnels im Operations Center.
 *
 * Visualisiert den {@link MarketDataOpsSnapshot}: Registry → Discovered →
 * Data-ready/Warming → Candles → Ticker/Spread → Scanner-ready, plus letzter
 * Sync je Venue, Fehlerzähler nach Ursache und die „worst offenders“
 * (ausklappbar). Der Funnel bleibt unverändert erhalten — bei `WARMING`/
 * `ERROR` erklärt das Panel, dass dessen Nullen datenbedingt sind.
 *
 * Accessibility: Der Ampelzustand ist nicht nur farb-, sondern immer auch
 * **textkodiert** (`READY`/`WARMING`/`ERROR` als sichtbarer Text mit
 * deutschem Label). Jede Kennzahl trägt einen Tooltip (Herkunft, Berechnung,
 * Sollwert). XSS-sicher: kein innerHTML, alles JSX-Text.
 *
 * Reine Darstellung — keine Hooks, kein Netz: testbar per
 * `renderToStaticMarkup` (test/ui/MarketDataPanel.test.tsx).
 */
import type { MarketDataOpsSnapshot, MarketDataReadinessStatus, OpsTone } from "@/ops/types";
import type { EligibilityDiagnosticsSummary } from "@/scanner/eligibilityDiagnostics";

const TONE_CLASS: Record<OpsTone, string> = {
  neutral: "text-slate-200",
  good: "text-emerald-300",
  warn: "text-amber-300",
  bad: "text-red-300",
};

/** Ampel: grün / gelb / rot — plus deutsches Textlabel (nie nur Farbe). */
const STATUS_META: Record<MarketDataReadinessStatus, { label: string; chip: string; box: string }> = {
  READY: {
    label: "bereit",
    chip: "bg-emerald-500/20 text-emerald-300 border border-emerald-700/50",
    box: "border-emerald-900/50 bg-emerald-950/20 text-emerald-200",
  },
  WARMING: {
    label: "Warmup",
    chip: "bg-amber-500/20 text-amber-300 border border-amber-700/50",
    box: "border-amber-900/50 bg-amber-950/20 text-amber-200",
  },
  ERROR: {
    label: "Fehler",
    chip: "bg-red-500/20 text-red-300 border border-red-700/50",
    box: "border-red-900/60 bg-red-950/30 text-red-200",
  },
};

/** Uhrzeit+Datum aus ISO-8601 (UTC), defensiv gegen kaputte Werte. */
function stampUtc(iso: string | null): string {
  if (!iso) return "nie";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "nie";
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)} UTC`;
}

export default function MarketDataPanel({
  snapshot,
  diagnostics,
}: {
  snapshot: MarketDataOpsSnapshot;
  diagnostics?: EligibilityDiagnosticsSummary | null;
}) {
  const s = snapshot;
  const meta = STATUS_META[s.readinessStatus] ?? STATUS_META.WARMING;
  const readyTone = (count: number): OpsTone =>
    s.registry === 0 ? "neutral" : count === 0 ? "bad" : count >= s.registry ? "good" : "warn";

  // Tooltips je Kennzahl: Herkunft, Berechnung, Sollwert (Review-Auflage).
  const rows: { label: string; value: string; tone: OpsTone; hint: string }[] = [
    {
      label: "Registry",
      value: String(s.registry),
      tone: "neutral",
      hint: "Instrumente in der Instrument-Registry (Single Source of Truth des Universums). Sollwert: > 0 nach npm run universe:seed bzw. Discovery.",
    },
    {
      label: "Discovered",
      value: String(s.discovered),
      tone: s.registry > 0 && s.discovered < s.registry ? "warn" : "neutral",
      hint: "Per Sync entdeckt: lastSeen innerhalb der letzten 24 h. Sollwert: = Registry. Rückstand bedeutet: die Discovery lief länger nicht.",
    },
    {
      label: "Data-ready",
      value: String(s.dataReady),
      tone: s.dataReady === 0 ? (s.registry > 0 ? "bad" : "neutral") : s.dataReady >= s.registry ? "good" : "warn",
      hint: `Instrumente mit ≥ ${s.requiredCandles} Kerzen im Scanner-Timeframe (Historical Store, data/history). Sollwert: = Registry.`,
    },
    {
      label: "Warming",
      value: String(s.warming),
      tone: s.warming > 0 ? "warn" : "neutral",
      hint: "Registry minus Data-ready — Instrumente ohne vollständige Kerzenhistorie. Behebung: npm run market:sync. Sollwert: 0.",
    },
    {
      label: "Candles",
      value: `${s.dataReady} / ${s.requiredCandles}`,
      tone: s.dataReady === 0 ? (s.registry > 0 ? "bad" : "neutral") : s.dataReady >= s.registry ? "good" : "warn",
      hint: `Instrumente mit vollständiger Kerzenhistorie / benötigte Kerzen je Instrument. Der Sollwert ${s.requiredCandles} wird dynamisch aus der Faktor-Konfiguration abgeleitet (requiredWarmupCandles: EMA50, Momentum-Lookback 60 + 1 Referenzkerze).`,
    },
    {
      label: "Ticker-ready",
      value: String(s.tickerReady),
      tone: readyTone(s.tickerReady),
      hint: "Instrumente mit volume24h ≠ null (Ticker-Enrichment, /market/tickers). Sollwert: = Registry. 0 bedeutet: Enrichment lief nie oder ist fehlgeschlagen.",
    },
    {
      label: "Spread-ready",
      value: String(s.spreadReady),
      tone: readyTone(s.spreadReady),
      hint: "Instrumente mit spread ≠ null (Orderbook-Enrichment, /market/depth — der Ticker liefert keinen Spread). Sollwert: = Registry. Ohne Spread lehnt der Scanner mit rule=max-spread ab.",
    },
    {
      label: "Scanner-ready",
      value: s.scannerReady ? "YES" : "NO",
      tone: s.scannerReady ? "good" : "bad",
      hint: "YES genau dann, wenn readinessStatus = READY: jedes Registry-Instrument hat Kerzen ≥ Sollwert, Volumen und Spread. Erst dann ist ein leerer Funnel eine fachliche Aussage.",
    },
  ];

  return (
    <article
      aria-label="Market Data"
      className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/60 p-4"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-100">Market Data</h3>
        {/* Ampel: farb- UND textkodiert (Accessibility) */}
        <span role="status" className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${meta.chip}`}>
          {s.readinessStatus} · {meta.label}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-slate-400">
        Datenpipeline vor dem Funnel: Discovery → Enrichment → Backfill → Readiness. Reine
        Lese-Aggregation (Registry + Historical Store + Sync-Status) — kein Netzwerk, kein
        Sync-Trigger. Stand {stampUtc(s.generatedAt)}.
      </p>

      <dl className="mt-3 space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-[11px] uppercase tracking-wider text-slate-500" title={row.hint}>
              {row.label}
            </dt>
            <dd className={`font-mono text-xs font-semibold ${TONE_CLASS[row.tone]}`} title={row.hint}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Kontextabhängiger, handlungsleitender Hinweis (buildReadinessHint) */}
      {s.hint && (
        <p className={`mt-3 rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${meta.box}`}>{s.hint}</p>
      )}

      {/* Funnel-Bezug: bei WARMING/ERROR sind dessen Nullen datenbedingt */}
      {s.readinessStatus !== "READY" && (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          Der Scanner-Funnel darunter bleibt sichtbar — seine Nullen sind in diesem Zustand
          datenbedingt und keine Marktbewertung.
        </p>
      )}

      {s.venues.length > 0 && (
        <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
          <p className="text-[11px] font-semibold text-slate-400">Letzter Sync je Venue</p>
          <ul className="mt-1.5 space-y-1">
            {s.venues.map((venue) => {
              const failures = Object.entries(venue.failuresByReason).sort((a, b) =>
                a[0] < b[0] ? -1 : 1,
              );
              return (
                <li key={venue.venue} className="text-[11px]">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate font-semibold text-slate-300">{venue.venue}</span>
                    <span className="shrink-0 text-slate-400">
                      {stampUtc(venue.lastSyncAt)}
                      {venue.lastSyncDegraded ? (
                        <span className="ml-1.5 font-semibold text-amber-300">degraded</span>
                      ) : null}
                    </span>
                  </div>
                  <div className="text-slate-500">
                    {venue.instruments} Instrument{venue.instruments === 1 ? "" : "e"}
                    {failures.length > 0 && (
                      <span className="text-red-300">
                        {" · Fehler: "}
                        {failures.map(([reason, count]) => `${reason}×${count}`).join(", ")}
                      </span>
                    )}
                    {failures.length === 0 && venue.lastSyncAt !== null && (
                      <span className="text-emerald-300/80"> · keine Fehler</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {s.worstOffenders.length > 0 && (
        <details className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-slate-400 hover:text-slate-200">
            Worst offenders ({s.worstOffenders.length}) — Instrumente mit den wenigsten Kerzen
          </summary>
          <table className="mt-2 w-full text-left text-[11px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                <th scope="col" className="pb-1 font-semibold">Instrument</th>
                <th scope="col" className="pb-1 text-right font-semibold">Kerzen</th>
                <th scope="col" className="pb-1 text-right font-semibold">Soll</th>
              </tr>
            </thead>
            <tbody>
              {s.worstOffenders.map((offender) => (
                <tr key={offender.instrumentId}>
                  <td className="truncate pr-2 text-slate-300" title={offender.instrumentId}>
                    {offender.instrumentId}
                  </td>
                  <td className="text-right font-mono text-amber-300">{offender.candles}</td>
                  <td className="text-right font-mono text-slate-400">{offender.required}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {diagnostics && diagnostics.total > 0 && (
        <details className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-slate-400 hover:text-slate-200">
            Ablehnungs-Diagnose ({diagnostics.total}
            {diagnostics.truncated ? `, erste ${diagnostics.items.length}` : ""})
          </summary>
          <ul className="mt-2 space-y-1.5">
            {diagnostics.items.map((item) => (
              <li key={item.instrument} className="text-[11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-slate-300" title={item.instrument}>
                    {item.instrument}
                  </span>
                  <span
                    className={`shrink-0 font-semibold ${
                      item.eligibility.dataQuality ? "text-amber-300" : "text-slate-300"
                    }`}
                  >
                    {item.eligibility.rule}
                    {item.eligibility.dataQuality ? " · Datenqualität" : " · fachlich"}
                  </span>
                </div>
                <div className="truncate text-slate-500">
                  Kerzen {item.eligibility.data.candles}
                  {" · Volumen "}
                  {item.eligibility.data.volume24h === null
                    ? "nicht geladen"
                    : item.eligibility.data.volume24h.toLocaleString("de-DE")}
                  {" · Spread "}
                  {item.eligibility.data.spread === null
                    ? "nicht geladen"
                    : item.eligibility.data.spread.toLocaleString("de-DE")}
                </div>
              </li>
            ))}
          </ul>
          {diagnostics.truncated && (
            <p className="mt-2 text-[10px] text-slate-500">
              … und {diagnostics.total - diagnostics.items.length} weitere (Ausgabe gedeckelt).
            </p>
          )}
        </details>
      )}
    </article>
  );
}
