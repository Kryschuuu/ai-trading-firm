"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/apiClient";
import InfoTip from "../ui/InfoTip";
import DataTable from "../ui/DataTable";
import Chip from "../ui/Chip";
import Button from "../ui/Button";
import { PANEL, PANEL_PADDED, SECTION_TITLE } from "../ui/layout";
import type { FirmData } from "./types";

function AdaptiveRiskPanel({ data }: { data: FirmData }) {
  const a = data.adaptiveRisk;
  const regimeStyle: Record<string, string> = {
    NORMAL: "bg-emerald-500/20 text-emerald-300 border-emerald-700/50",
    ELEVATED: "bg-amber-500/20 text-amber-300 border-amber-700/50",
    EXTREME: "bg-red-500/20 text-red-300 border-red-700/50",
  };
  const regimeLabel: Record<string, string> = {
    NORMAL: "Normal",
    ELEVATED: "Erhöhte Volatilität",
    EXTREME: "Extreme Volatilität",
  };

  return (
    <section>
      <h2 className={`mb-2 ${SECTION_TITLE}`}>
        Adaptives Risiko — volatilitätsgetriebene Limit-Anpassung
      </h2>
      {!a ? (
        <div className={`${PANEL} p-4`}>
          <p className="text-sm text-slate-400">
            Noch keine Bewertung. Der nächste Monitor-Tick (≈60 s) startet das adaptive
            System automatisch — oder löse manuell aus via{" "}
            <code className="rounded bg-slate-800 px-1 py-0.5 text-xs text-slate-200">
              POST /api/firm/risk/volatility
            </code>
            .
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 3xl:grid-cols-3">
          {/* Regime + wirksames Limit */}
          <div className={`${PANEL} p-4`}>
            <div className="mb-3 flex items-center justify-between">
              <span className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide ${regimeStyle[a.regime] ?? regimeStyle.NORMAL}`}>
                {regimeLabel[a.regime] ?? a.regime}
              </span>
              {a.stale && (
                <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">stale</span>
              )}
            </div>
            <div className="space-y-1 text-sm">
              <p className="text-slate-400">
                maxRiskPerTrade:{" "}
                <span className="font-mono text-slate-500 line-through">
                  {(a.baseMaxRiskPerTrade * 100).toFixed(2)} %
                </span>{" "}
                → <span className="font-mono font-bold text-emerald-300">{(a.effectiveMaxRiskPerTrade * 100).toFixed(2)} %</span>
              </p>
              <p className="text-xs text-slate-500">Faktor {a.factor} · Basis {a.baseMaxRiskPerTrade}</p>
              <p className="text-xs text-slate-400">{a.reason}</p>
              {a.lastUpdate && (
                <p className="pt-1 text-xs text-slate-500">
                  Aktualisiert {new Date(a.lastUpdate).toLocaleTimeString()}
                  {a.lastChange && a.lastChange !== a.lastUpdate ? ` · letzte Änderung ${new Date(a.lastChange).toLocaleTimeString()}` : ""}
                </p>
              )}
              {a.lastError && <p className="text-xs text-amber-400">Quelle: {a.lastError}</p>}
            </div>
          </div>

          {/* Indikatoren */}
          <div className={`${PANEL} p-4`}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Indikatoren</h3>
            <DataTable
              label="Volatilitäts-Indikatoren und Schwellen"
              className="-mx-1"
              stack={false}
              head={["Indikator", "Wert", "Schwelle", "Status"]}
              align={["left", "right", "right", "right"]}
              empty="Keine Indikatoren gemeldet."
              rows={a.indicators.map((ind) => [
                <span key={`${ind.name}-name`} className="font-medium text-slate-300">{ind.name}</span>,
                <span key={`${ind.name}-value`} className="font-mono tabular-nums text-slate-400">
                  {ind.value != null
                    ? ind.name === "VIX" ? ind.value.toFixed(1) : `${(ind.value * 100).toFixed(2)} %`
                    : "n/v"}
                </span>,
                <span key={`${ind.name}-threshold`} className="font-mono text-slate-500">
                  {ind.name === "VIX" ? ind.threshold : `${(ind.threshold * 100).toFixed(2)} %`}
                </span>,
                !ind.available ? (
                  <span key={`${ind.name}-state`} className="text-slate-600">nicht verfügbar</span>
                ) : ind.triggered ? (
                  <span key={`${ind.name}-state`} className="font-bold text-amber-300">⚠ ausgelöst</span>
                ) : (
                  <span key={`${ind.name}-state`} className="text-emerald-400">✓ unter Schwelle</span>
                ),
              ])}
            />
          </div>

          {/* Letztes Event */}
          <div className={`${PANEL} p-4`}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Letztes Trigger-Event</h3>
            {a.events.length === 0 ? (
              <p className="text-xs text-slate-500">Keine Ereignisse seit Prozessstart.</p>
            ) : (
              (() => {
                const e = a.events[0];
                return (
                  <div className="space-y-1 text-xs text-slate-400">
                    <p>
                      <span className="font-mono text-slate-500">{e.prevRegime}</span> →{" "}
                      <span className="font-bold text-slate-200">{e.regime}</span>{" "}
                      <span className="font-mono">
                        ({(e.baseMaxRiskPerTrade * 100).toFixed(2)} % → {(e.effectiveMaxRiskPerTrade * 100).toFixed(2)} %)
                      </span>
                    </p>
                    <p className="text-slate-300">{e.reason}</p>
                    <p className="text-slate-600">
                      {new Date(e.at).toLocaleString()}
                      {e.triggered.length > 0 && ` · Trigger: ${e.triggered.join(", ")}`}
                    </p>
                  </div>
                );
              })()
            )}
            <p className="mt-3 text-xs text-slate-600">
              Vollständige Historie: <code className="text-slate-500">GET /api/firm/risk/volatility</code> und
              Audit-Log <code className="text-slate-500">RISK_ADAPTIVE</code>.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

type VolSectionProps = {
  data: FirmData;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  saving: string | null;
  save: (key: string, raw: string) => void;
};

/**
 * Volatilitäts-Schwellen & Faktoren (Runtime-Konfiguration).
 *
 * Wie die Risikotabelle: viele Spalten mit Eingabefeldern, deshalb `stack={false}`
 * — auf schmalen Bildschirmen scrollt die Tabelle horizontal, statt Zeilen in
 * Karten zu verwandeln, in denen Eingabefeld und Bedeutung auseinanderfallen.
 */
function VolatilityConfigSection(props: VolSectionProps) {
  const { data, drafts, setDrafts, saving, save } = props;
  const rows = data.volatilityConfig ?? [];
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className={`mb-2 ${SECTION_TITLE}`}>
        Volatilitäts-Schwellwerte &amp; Faktoren — zur Laufzeit änderbar
      </h2>
      <DataTable
        label="Volatilitäts-Konfiguration"
        stack={false}
        stickyHead
        maxHeight="70vh"
        head={["Parameter", "Wirksam", "Fenster", "Ändern", "Bedeutung"]}
        rows={rows.map((c) => {
          const isPct = c.unit === "%";
          const isBool = c.unit === "bool";
          const fmtVal = isBool
            ? (c.value ? "an" : "aus")
            : isPct
              ? `${(Number(c.value) * 100).toFixed(2)} %`
              : String(c.value);
          const fmtBound = (v: number) => (isPct ? `${v * 100}%` : String(v));
          const draft = drafts[c.key] ?? "";
          return [
            <span key={`${c.key}-label`} className="font-medium text-slate-200">{c.label}</span>,
            <span key={`${c.key}-value`} className="font-bold tabular-nums text-emerald-300">{fmtVal}</span>,
            <span key={`${c.key}-bounds`} className="text-xs tabular-nums text-slate-500">
              {fmtBound(c.min)} – {fmtBound(c.max)}
            </span>,
            c.locked ? (
              <span key={`${c.key}-locked`} className="text-xs text-slate-500">🔒 gesperrt</span>
            ) : (
              <div key={`${c.key}-editor`} className="flex items-center gap-1">
                <input
                  type="number"
                  step="any"
                  aria-label={`${c.label} neuer Wert`}
                  placeholder={String(typeof c.value === "number" && isPct ? (Number(c.value) * 100).toFixed(2) : c.value)}
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && draft !== "" && save(c.key, draft)}
                  className={`w-28 rounded border bg-slate-800 px-2 py-1 text-xs text-slate-200 ${
                    draft !== "" && Number(draft.replace(",", ".")) > (isPct ? c.max * 100 : c.max)
                      ? "border-red-600"
                      : "border-slate-700"
                  }`}
                />
                {isPct && <span className="text-xs text-slate-500">%</span>}
                <Button
                  variant="primary"
                  size="sm"
                  aria-label={`${c.label} speichern`}
                  onClick={() => draft !== "" && save(c.key, draft)}
                  disabled={saving === c.key || draft === ""}
                >
                  ✓
                </Button>
              </div>
            ),
            <span key={`${c.key}-description`} className="text-xs text-slate-400">{c.description}</span>,
          ];
        })}
      />
      <p className="mt-3 rounded-lg border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-300">
        Werte wirken ab dem nächsten Turn/Tick ohne Neustart. Jede Änderung landet revisionssicher
        im Audit-Log (<code className="font-mono">CONFIG_CHANGED</code>). Die absoluten Grenzen
        (<code className="font-mono">LIMIT_CEILINGS</code> in <code className="font-mono">riskGuard.ts</code>)
        bleiben im kompilierten Code — auch eine kompromittierte Datenbank kann sie nicht aufweichen.
        Prozentwerte werden als Zahl eingegeben (z. B. 30 für 30 %).
      </p>
    </section>
  );
}

export default function RiskTab({ data, onChanged }: { data: FirmData; onChanged: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const allConfig = [...data.riskConfig, ...(data.volatilityConfig ?? [])];

  async function save(key: string, rawValue: string) {
    setSaving(key);
    setMsg("");
    const entry = allConfig.find((c) => c.key === key);
    const num =
      entry?.unit === "bool" ? (rawValue === "true" || rawValue === "1" ? 1 : 0) : Number(rawValue.replace(",", "."));
    const res = await apiFetch("/api/firm/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: num }),
    });
    if (res.status === 401) {
      setMsg("🔒 Aktion blockiert: FIRM_API_TOKEN ist aktiv und der Browser hat keinen gültigen Token (erst im Haupt-Tab oben hinterlegen).");
      setSaving(null);
      return;
    }
    const json = await res.json();
    setSaving(null);
    if (json.ok) {
      setMsg(`${key} gesetzt auf ${json.effective}${json.effective !== num ? ` (Eingabe ${num} wurde vom Code-Fenster geklemmt)` : ""}`);
      setDrafts((d) => ({ ...d, [key]: "" }));
      onChanged();
    } else {
      setMsg(`Fehler bei ${key}: ${json.error}`);
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className={`mb-2 ${SECTION_TITLE}`}>
          Risikokonfiguration — zur Laufzeit änderbar, im Code begrenzt
        </h2>
        <DataTable
          label="Risikokonfiguration"
          stack={false}
          stickyHead
          maxHeight="70vh"
          head={["Limit", "Wirksam", "Erlaubtes Fenster", "Ändern", "Bedeutung"]}
          rows={data.riskConfig.map((c) => {
            const isPct = c.unit === "%";
            const fmtVal = typeof c.value === "boolean"
              ? (c.value ? "ja" : "nein")
              : isPct
                ? `${(Number(c.value) * 100).toFixed(1)} %`
                : String(c.value);
            const fmtBound = (v: number) => (isPct ? `${v * 100}%` : v);
            const draft = drafts[c.key] ?? "";
            return [
              <span key={`${c.key}-label`} className="font-medium text-slate-200">{c.label}</span>,
              <span key={`${c.key}-value`} className="font-bold tabular-nums text-emerald-300">{fmtVal}</span>,
              <span key={`${c.key}-bounds`} className="text-xs tabular-nums text-slate-500">
                {fmtBound(c.min)} – {fmtBound(c.max)}
              </span>,
              c.locked ? (
                <span key={`${c.key}-locked`} className="text-xs text-slate-500">🔒 gesperrt</span>
              ) : (
                <div key={`${c.key}-editor`} className="flex items-center gap-1">
                  {c.unit === "bool" ? (
                    <select
                      aria-label={`${c.label} umschalten`}
                      value={String(c.value)}
                      onChange={(e) => save(c.key, e.target.value)}
                      disabled={saving === c.key}
                      className="w-24 rounded border border-slate-700 bg-slate-800 px-1.5 py-1 text-xs text-slate-200"
                    >
                      <option value={typeof c.value === "boolean" ? String(c.value) : String(Number(c.value) >= 0.5)}>
                        aktuell
                      </option>
                      <option value="1">an</option>
                      <option value="0">aus</option>
                    </select>
                  ) : (
                    <>
                      <input
                        type="number"
                        step="any"
                        aria-label={`${c.label} neuer Wert`}
                        placeholder={String(typeof c.value === "number" && isPct ? (Number(c.value) * 100).toFixed(1) : c.value)}
                        value={draft}
                        onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && draft !== "" && save(c.key, draft)}
                        className={`w-28 rounded border bg-slate-800 px-2 py-1 text-xs text-slate-200 ${
                          draft !== "" && Number(draft.replace(",", ".")) > (isPct ? c.max * 100 : c.max)
                            ? "border-red-600"
                            : "border-slate-700"
                        }`}
                      />
                      {isPct && <span className="text-xs text-slate-500">%</span>}
                      <Button
                        variant="primary"
                        size="sm"
                        aria-label={`${c.label} speichern`}
                        onClick={() => draft !== "" && save(c.key, draft)}
                        disabled={saving === c.key || draft === ""}
                      >
                        ✓
                      </Button>
                    </>
                  )}
                </div>
              ),
              <span key={`${c.key}-description`} className="text-xs text-slate-400">{c.description}</span>,
            ];
          })}
        />
        {msg && (
          <p role="status" className="mt-2 rounded-lg border border-sky-700/50 bg-sky-950/30 px-3 py-2 text-xs text-sky-300">{msg}</p>
        )}
        <p className="mt-3 rounded-lg border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-300">
          Werte wirken ab dem nächsten Turn/Tick ohne Neustart. Jede Änderung landet revisionssicher
          im Audit-Log (<code className="font-mono">CONFIG_CHANGED</code>). Die absoluten Grenzen
          (<code className="font-mono">LIMIT_CEILINGS</code> in <code className="font-mono">riskGuard.ts</code>)
          bleiben im kompilierten Code — auch eine kompromittierte Datenbank kann sie nicht aufweichen.
          Prozentwerte werden als Zahl eingegeben (z. B. 30 für 30 %).
        </p>
      </section>

      <AdaptiveRiskPanel data={data} />

      <VolatilityConfigSection data={data} drafts={drafts} setDrafts={setDrafts} saving={saving} save={save} />

      <section>
        <h2 className={`mb-2 ${SECTION_TITLE}`}>
          Ollama-Status
          <InfoTip
            label="Ollama-Status"
            text="Lokaler LLM-Server für die Agenten-Rollen. Ist er nicht erreichbar, entscheidet die deterministische Regel-Engine weiter — Betrieb bleibt möglich, nur ohne Modell-Freiheitsgrade."
          />
        </h2>
        <div className={PANEL_PADDED}>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex items-baseline gap-2">
              <dt className="text-slate-400">Erreichbar:</dt>
              <dd className={data.ollama.available ? "text-emerald-400" : "text-red-400"}>
                {data.ollama.available ? "ja" : "nein"}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-slate-400">Endpunkt:</dt>
              <dd className="font-mono text-xs text-slate-300">{data.ollama.baseUrl || "http://127.0.0.1:11434"}</dd>
            </div>
            {data.ollama.error && (
              <div className="flex items-baseline gap-2 sm:col-span-2">
                <dt className="text-slate-400">Fehler:</dt>
                <dd className="text-red-400">{data.ollama.error}</dd>
              </div>
            )}
            {data.ollama.models.length > 0 && (
              <div className="flex items-baseline gap-2 sm:col-span-2">
                <dt className="text-slate-400">Modelle:</dt>
                <dd className="text-slate-300">{data.ollama.models.join(", ")}</dd>
              </div>
            )}
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            Ohne erreichbares Ollama fällt die Firma auf die deterministische Regel-Engine zurück —
            Orchestrierung und Guardrail-Pipeline bleiben damit vollständig vorführbar.
          </p>
        </div>
      </section>

      <section>
        <h2 className={`mb-2 ${SECTION_TITLE}`}>
          Kill-Switch-Historie
          <InfoTip
            label="Kill-Switch-Historie"
            text="Jede Auslösung und Entschärfung des Not-Halts mit Auslöser und Begründung — revisionssicher im Audit-Log gespiegelt."
          />
        </h2>
        <DataTable
          label="Kill-Switch-Historie"
          head={["Ausgelöst von", "Grund", "Scharf"]}
          empty="Noch keine Kill-Switch-Ereignisse — der Not-Halt wurde nie gezogen."
          rows={data.killSwitches.map((k) => [
            k.triggeredBy,
            k.reason,
            <Chip key={`${k.triggeredBy}-${k.reason}`} tone={k.armed ? "bad" : "neutral"}>
              {k.armed ? "ja" : "nein"}
            </Chip>,
          ])}
        />
      </section>
    </div>
  );
}
