"use client";

/**
 * Schritt 5: Regel als DRAFT speichern und gegen den Paper-Store messen.
 *
 * Kein Import von `ruleEngine` (Client-Bundle). Die Whitelist kommt aus
 * `ruleFieldCatalog`. Aktivierung und Missionsvorlagen bleiben außen vor.
 */

import { useState } from "react";
import InfoTip from "./InfoTip";
import { apiFetch, readJson } from "@/lib/apiClient";
import { RULE_FIELD_LABELS, RULE_FIELDS } from "@/lib/ruleFieldCatalog";

type FieldName = keyof typeof RULE_FIELDS;
type Op = "lt" | "lte" | "gt" | "gte" | "eq" | "between";

type ConditionDraft = {
  id: string;
  field: FieldName;
  op: Op;
  value: string;
  valueHi: string;
};

type SavedRule = { id: string; status?: string; name?: string; symbol?: string };

type BacktestBody = {
  ok?: boolean;
  error?: string;
  executionModel?: string;
  interval?: string;
  candles?: number;
  note?: string;
  instrumentId?: string | null;
  seriesWarning?: string | null;
  result?: {
    stats?: {
      trades?: number;
      wins?: number;
      losses?: number;
      pnl?: number;
      pnlPct?: number;
      profitFactor?: number | null;
      maxDrawdownPct?: number;
      totalFeesPaid?: number | null;
      totalSlippagePaid?: number | null;
      totalFundingPaid?: number | null;
    };
    equityCurve?: { t: number; equity: number }[];
  };
};

const FIELDS = Object.keys(RULE_FIELDS) as FieldName[];
const NUMERIC_OPS: Op[] = ["lt", "lte", "gt", "gte", "eq", "between"];

function nextId(): string {
  return `c-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyCondition(): ConditionDraft {
  return { id: nextId(), field: "rsi14", op: "lt", value: "30", valueHi: "" };
}

export default function RuleBacktestPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [name, setName] = useState("Workshop-Entwurf");
  const [symbol, setSymbol] = useState("BTC/USDT");
  const [storeId, setStoreId] = useState("");
  const [timeframe, setTimeframe] = useState("15m");
  const [stopLossPct, setStopLossPct] = useState("5");
  const [takeProfitRR, setTakeProfitRR] = useState("1.5");
  const [riskBudgetPct, setRiskBudgetPct] = useState("0.01");
  const [maxPositionPct, setMaxPositionPct] = useState("0.15");
  const [conditions, setConditions] = useState<ConditionDraft[]>([emptyCondition()]);
  const [saved, setSaved] = useState<SavedRule | null>(null);
  const [busy, setBusy] = useState<"save" | "remeasure" | null>(null);
  const [saveError, setSaveError] = useState("");
  const [measureError, setMeasureError] = useState("");
  const [measure, setMeasure] = useState<BacktestBody | null>(null);

  function specBody() {
    return {
      activate: false,
      rule: {
        name: name.trim(),
        symbol: symbol.trim(),
        rationale: "Workshop-Schritt 5, nur Entwurf. Keine Aktivierung.",
        condition: {
          logic: "all",
          conditions: conditions.map((condition) => {
            if (condition.field === "trend") {
              return { field: "trend", op: "eq", value: condition.value.trim().toUpperCase() || "UP" };
            }
            if (condition.op === "between") {
              return {
                field: condition.field,
                op: "between",
                value: [Number(condition.value.replace(",", ".")), Number(condition.valueHi.replace(",", "."))],
              };
            }
            return {
              field: condition.field,
              op: condition.op,
              value: Number(condition.value.replace(",", ".")),
            };
          }),
        },
        action: {
          side: "LONG",
          stopLossPct: Number(stopLossPct.replace(",", ".")),
          takeProfitRR: Number(takeProfitRR.replace(",", ".")),
          riskBudgetPct: Number(riskBudgetPct.replace(",", ".")),
          maxPositionPct: Number(maxPositionPct.replace(",", ".")),
        },
        window: { timeframe, maxExecutionsPerDay: 3, cooldownMinutes: 60, volumeWindow: 20 },
      },
    };
  }

  async function measureRule(id: string) {
    const { res, data, error } = await readJson<BacktestBody>(
      await apiFetch(`/api/firm/rules/${id}/backtest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "paper",
          limit: 300,
          ...(storeId.trim() ? { instrumentId: storeId.trim() } : {}),
        }),
      }),
      "Backtest fehlgeschlagen",
    );
    if (res.status === 401) {
      onUnauthorized();
      return;
    }
    if (error || data.ok === false) {
      setMeasure(null);
      setMeasureError(error || data.error || `Backtest abgelehnt (${res.status}).`);
      return;
    }
    setMeasureError("");
    setMeasure(data);
  }

  async function saveAndMeasure() {
    setBusy("save");
    setSaveError("");
    setMeasureError("");
    setMeasure(null);
    const { res, data, error } = await readJson<{ ok?: boolean; error?: string; errors?: string[]; rule?: SavedRule }>(
      await apiFetch("/api/firm/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(specBody()),
      }),
      "Entwurf konnte nicht gespeichert werden",
    );
    setBusy(null);
    if (res.status === 401) {
      onUnauthorized();
      return;
    }
    if (error || !data.rule?.id) {
      const detail = data.errors?.length ? data.errors.join(" ") : data.error;
      setSaveError(error || detail || `Speichern abgelehnt (${res.status}).`);
      setSaved(null);
      return;
    }
    setSaved(data.rule);
    setBusy("remeasure");
    await measureRule(data.rule.id);
    setBusy(null);
  }

  async function remeasure() {
    if (!saved?.id) return;
    setBusy("remeasure");
    setMeasureError("");
    await measureRule(saved.id);
    setBusy(null);
  }

  const stats = measure?.result?.stats;
  const curve = measure?.result?.equityCurve ?? [];
  const curvePath = curve.length > 1
    ? (() => {
        const min = Math.min(...curve.map((point) => point.equity));
        const max = Math.max(...curve.map((point) => point.equity));
        const span = max - min || 1;
        return curve
          .map((point, index) => {
            const x = (index / (curve.length - 1)) * 280;
            const y = 64 - ((point.equity - min) / span) * 56;
            return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");
      })()
    : "";

  return (
    <section aria-labelledby="rule-backtest-title" className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center">
        <h3 id="rule-backtest-title" className="text-sm font-bold text-slate-100">Regel prüfen, nur als Entwurf</h3>
        <InfoTip
          id="rule-backtest-title"
          label="Regel-Entwurf"
          text="Speichert eine DRAFT-Regel und misst sie gegen eine Historical-Store-Reihe mit Paper-Kosten. Die Store-ID ist nicht das Regel-Symbol. Aktiviert nichts und lädt keine Kurse nach."
        />
      </div>
      <p className="text-xs text-slate-500">
        „Als Entwurf speichern und messen“ schreibt `activate: false`. „Erneut messen“ benutzt dieselbe Regel und die aktuelle Store-ID, ohne eine zweite Regel zu speichern.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-slate-300">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
        </label>
        <label className="text-xs font-semibold text-slate-300">
          Symbol
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
        </label>
        <label className="text-xs font-semibold text-slate-300">
          Store-ID
          <input
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
            placeholder="BITUNIX:BTCUSDT"
            aria-describedby="store-id-hint"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs font-semibold text-slate-300">
          Fenster
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100">
            {["1m", "5m", "15m", "30m", "1h"].map((tf) => <option key={tf} value={tf}>{tf}</option>)}
          </select>
        </label>
      </div>
      <p id="store-id-hint" className="text-xs text-slate-500">
        Symbol ist die Regel, zum Beispiel BTC/USDT. Store-ID ist der Schlüssel im Historical Store, zum Beispiel BITUNIX:BTCUSDT. Leer lassen nur, wenn genau eine Reihe zu diesem Symbol existiert.
      </p>

      <div className="space-y-2">
        {conditions.map((condition) => (
          <div key={condition.id} className="grid gap-2 sm:grid-cols-4">
            <select
              aria-label="Feld"
              value={condition.field}
              onChange={(e) => setConditions((rows) => rows.map((row) => row.id === condition.id ? { ...row, field: e.target.value as FieldName } : row))}
              className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100"
            >
              {FIELDS.map((field) => <option key={field} value={field}>{RULE_FIELD_LABELS[field]}</option>)}
            </select>
            <select
              aria-label="Operator"
              value={condition.field === "trend" ? "eq" : condition.op}
              disabled={condition.field === "trend"}
              onChange={(e) => setConditions((rows) => rows.map((row) => row.id === condition.id ? { ...row, op: e.target.value as Op } : row))}
              className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100"
            >
              {(condition.field === "trend" ? ["eq"] : NUMERIC_OPS).map((op) => <option key={op} value={op}>{op}</option>)}
            </select>
            <input
              aria-label="Wert"
              value={condition.value}
              onChange={(e) => setConditions((rows) => rows.map((row) => row.id === condition.id ? { ...row, value: e.target.value } : row))}
              className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100"
            />
            {condition.op === "between" && condition.field !== "trend" ? (
              <input
                aria-label="Oberer Wert"
                value={condition.valueHi}
                onChange={(e) => setConditions((rows) => rows.map((row) => row.id === condition.id ? { ...row, valueHi: e.target.value } : row))}
                className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100"
              />
            ) : (
              <button
                type="button"
                onClick={() => setConditions((rows) => rows.length === 1 ? rows : rows.filter((row) => row.id !== condition.id))}
                className="rounded-lg border border-slate-700 px-2 py-2 text-xs text-slate-400"
              >
                Entfernen
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={() => setConditions((rows) => [...rows, emptyCondition()])} className="text-xs font-semibold text-sky-300">
          + Bedingung
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ["Stop %", stopLossPct, setStopLossPct],
          ["Chance/Risiko", takeProfitRR, setTakeProfitRR],
          ["Risikoanteil", riskBudgetPct, setRiskBudgetPct],
          ["Positionsanteil", maxPositionPct, setMaxPositionPct],
        ].map(([label, value, setter]) => (
          <label key={String(label)} className="text-xs font-semibold text-slate-300">
            {label as string}
            <input value={value as string} onChange={(e) => (setter as (v: string) => void)(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-100" />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void saveAndMeasure()}
          disabled={busy !== null}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy === "save" ? "Speichern…" : "Als Entwurf speichern und messen"}
        </button>
        <button
          type="button"
          onClick={() => void remeasure()}
          disabled={busy !== null || !saved?.id}
          className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40"
        >
          {busy === "remeasure" ? "Messen…" : "Erneut messen"}
        </button>
      </div>

      {saved && (
        <p className="text-xs text-emerald-300">
          Entwurf gespeichert: {saved.name ?? name} · {saved.id} · Status {saved.status ?? "DRAFT"}. Eine fehlgeschlagene Messung löscht diesen Entwurf nicht.
        </p>
      )}
      {saveError && <p role="alert" className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-300">{saveError}</p>}
      {measureError && <p role="alert" className="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">{measureError}</p>}

      {stats && (
        <div className="grid gap-3 lg:grid-cols-2">
          <dl className="grid grid-cols-2 gap-2 text-xs text-slate-300">
            <div>Modell <strong className="text-slate-100">{measure?.executionModel}</strong></div>
            <div>Fenster <strong className="text-slate-100">{measure?.interval}</strong> · {measure?.candles} Kerzen</div>
            <div>Trades {stats.trades} · Gewinne {stats.wins} · Verluste {stats.losses}</div>
            <div>PnL {stats.pnl} · {stats.pnlPct} %</div>
            <div>Profit-Faktor {stats.profitFactor ?? "—"}</div>
            <div>Max. Drawdown {stats.maxDrawdownPct} %</div>
            <div>Gebühren {stats.totalFeesPaid ?? "—"}</div>
            <div>Slippage {stats.totalSlippagePaid ?? "—"} · Funding {stats.totalFundingPaid ?? "—"}</div>
          </dl>
          {curvePath && (
            <svg viewBox="0 0 280 72" className="h-20 w-full rounded border border-slate-800 bg-slate-950" role="img" aria-label="Equity-Kurve des Paper-Laufs">
              <path d={curvePath} fill="none" stroke="#38bdf8" strokeWidth="1.5" />
            </svg>
          )}
          {measure?.seriesWarning && (
            <p role="status" className="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-200 lg:col-span-2">{measure.seriesWarning}</p>
          )}
          {measure?.note && <p className="text-[11px] leading-relaxed text-slate-500 lg:col-span-2">{measure.note}</p>}
        </div>
      )}
    </section>
  );
}
