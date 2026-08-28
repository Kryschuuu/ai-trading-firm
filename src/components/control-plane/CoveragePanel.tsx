"use client";

/**
 * Coverage-Panel „Venues & Coverage" (Operations Center).
 *
 * Ersetzt die irreführende Zählung „7 Broker" durch eine differenzierte Ansicht:
 *
 *   7 Venues registriert
 *   1 Venue mit vollständiger Discovery
 *   1 Venue mit Paper-Market-Data
 *   0 Venues mit aktiviertem Live Trading
 *
 * Plus fünf Coverage-Balken (Discovery / Market Data / Paper / Testnet / Live
 * Execution) und eine Detailtabelle je Venue mit den aktuellen Capabilities.
 *
 * Liest ausschließlich GET /api/brokers/coverage (reine Projektion der
 * Capability-SSoT + Live-Gate). XSS-sicher: kein innerHTML, alles JSX-Text.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchBrokerCoverage,
  type BrokerCoverageResponse,
} from "@/lib/controlPlane";

function pluralVenue(n: number): string {
  return n === 1 ? "Venue" : "Venues";
}

/** Ein Headline-Wert mit Beschriftung (große Zahl + Text). */
function Headline({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: "neutral" | "good" | "warn" | "locked";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "locked"
          ? "text-red-300"
          : "text-slate-100";
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
      <p className={`text-2xl font-black tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-0.5 text-[11px] leading-tight text-slate-400">{label}</p>
    </div>
  );
}

/** Ein Coverage-Balken (covered/total) mit Prozentanzeige. */
function CoverageBar({
  label,
  covered,
  total,
}: {
  label: string;
  covered: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((covered / total) * 100) : 0;
  const barColor =
    covered === 0
      ? "bg-slate-700"
      : pct >= 100
        ? "bg-emerald-500"
        : pct >= 50
          ? "bg-sky-500"
          : "bg-amber-500";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold text-slate-300">{label}</span>
        <span className="font-mono text-[11px] text-slate-400">
          {covered}/{total} · {pct}%
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-valuenow={covered}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={label}
      >
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Ja/Nein-Zelle der Detailtabelle. */
function CapCell({ on }: { on: boolean }) {
  return on ? (
    <span className="text-emerald-400" aria-label="ja">
      ✓
    </span>
  ) : (
    <span className="text-slate-600" aria-label="nein">
      —
    </span>
  );
}

export default function CoveragePanel() {
  const [data, setData] = useState<BrokerCoverageResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetchBrokerCoverage();
    if (!mounted.current) return;
    if (res.error || !res.data?.ok) {
      setError(res.error || "Coverage konnte nicht geladen werden.");
      setData(null);
    } else {
      setData(res.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  return (
    <section className="space-y-4 rounded-xl border border-indigo-800/50 bg-indigo-500/5 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-indigo-300">
            📊 Venues &amp; Coverage
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            Getrennte Sicht auf <strong>registrierte</strong> und{" "}
            <strong>tatsächlich abgedeckte</strong> Venues. Die Zahlen sind eine
            ehrliche Projektion der Adapter-Capabilities (Single Source of Truth)
            und des Live-Gate-Enforcers — kein Netzwerk, keine Credentials.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
        >
          {loading ? "Lade …" : "↻ Aktualisieren"}
        </button>
      </div>

      {loading && data === null && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-xl border border-slate-800 bg-slate-900/40"
            />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-red-800/60 bg-red-950/40 p-4 text-sm text-red-300">
          <p className="font-bold">Coverage konnte nicht geladen werden.</p>
          <p className="mt-1 text-xs">{error}</p>
        </div>
      )}

      {data && (
        <>
          {/* Headline-Kennzahlen */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Headline
              value={data.registeredVenues}
              label={`${pluralVenue(data.registeredVenues)} registriert (Adapter vorhanden)`}
              tone="neutral"
            />
            <Headline
              value={data.fullDiscoveryVenues}
              label={`${pluralVenue(
                data.fullDiscoveryVenues
              )} mit vollständiger Discovery`}
              tone="good"
            />
            <Headline
              value={data.paperMarketDataVenues}
              label={`${pluralVenue(
                data.paperMarketDataVenues
              )} mit Paper-Market-Data`}
              tone="good"
            />
            <Headline
              value={data.liveEnabledVenues}
              label={`${pluralVenue(
                data.liveEnabledVenues
              )} mit aktiviertem Live Trading`}
              tone={data.liveEnabledVenues > 0 ? "warn" : "locked"}
            />
          </div>
          <p className="text-[11px] text-slate-500">
            Headline-Zahlen zählen <strong>reale externe</strong> Venues; der
            interne PAPER-Simulator ({data.internalVenues}) ist in der Tabelle
            transparent als <em>intern</em> markiert.
          </p>

          {/* Coverage-Balken */}
          <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.metrics.map((m) => (
              <CoverageBar
                key={m.id}
                label={m.label}
                covered={m.covered}
                total={m.total}
              />
            ))}
          </div>

          {/* Detailtabelle */}
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="bg-slate-950/60 text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Venue</th>
                  <th className="px-3 py-2 font-semibold">Typ</th>
                  <th className="px-3 py-2 text-center font-semibold">Discovery</th>
                  <th className="px-3 py-2 text-center font-semibold">
                    Market Data
                  </th>
                  <th className="px-3 py-2 text-center font-semibold">Paper</th>
                  <th className="px-3 py-2 text-center font-semibold">Testnet</th>
                  <th className="px-3 py-2 text-center font-semibold">
                    Live (Fähigkeit)
                  </th>
                  <th className="px-3 py-2 text-center font-semibold">
                    Live (aktiv)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {data.rows.map((r) => (
                  <tr key={r.venue} className="hover:bg-slate-900/40">
                    <td className="px-3 py-2">
                      <span className="font-semibold text-slate-200">
                        {r.label}
                      </span>
                      <span className="ml-1.5 font-mono text-[10px] text-slate-500">
                        {r.venue}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {r.internal ? (
                        <span className="rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-[10px] text-slate-400">
                          intern
                        </span>
                      ) : (
                        <span className="rounded border border-sky-800/60 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                          extern
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <CapCell on={r.discovery} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <CapCell on={r.marketData} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <CapCell on={r.paperExecution} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <CapCell on={r.testnetExecution} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <CapCell on={r.liveCapable} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      {r.liveEnabled ? (
                        <span className="text-amber-300" title={r.liveReason}>
                          aktiv
                        </span>
                      ) : (
                        <span
                          className="text-red-400"
                          title={r.liveReason}
                        >
                          gesperrt
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500">
            <strong>Live (Fähigkeit)</strong> = der Adapter kann technisch
            Live-Orders serialisieren. <strong>Live (aktiv)</strong> = das
            zentrale Live-Gate gibt reale Orders frei — Default gesperrt, bis die
            State-Machine (Task 11) vollständig durchlaufen ist.
          </p>
        </>
      )}
    </section>
  );
}
