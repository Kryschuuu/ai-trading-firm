/**
 * Runtime-Risikokonfiguration.
 *
 * Lädt die Limits aus der Tabelle `risk_config` und legt sie via
 * applyRuntimeLimits() über die Code-Ceilings gelegt wirksam. Wird zu Beginn
 * jedes Agenten-Turns, jedes Monitor-Ticks und nach jeder Änderung aufgerufen.
 *
 * Sicherheitsmodell:
 *   - Code (LIMIT_CEILINGS) definiert das absolute Fenster.
 *   - DB/Dashboard darf innerhalb des Fensters frei einstellen.
 *   - Fehlt die DB oder ein Wert ist Unsinn → gilt der jeweilige Code-Default.
 */
import { db } from "@/db";
import { riskConfig } from "@/db/schema";
import { applyRuntimeLimits, getLimits, DEFAULT_LIMITS, LIMIT_CEILINGS, type RiskLimits } from "./riskGuard";
import { logAudit } from "./engine";

const GLOBAL = globalThis as typeof globalThis & { __riskCfgLoadedAt?: number };
const RELOAD_TTL_MS = 10_000;

/** Beschreibbare Schlüssel mit Metadaten für Dashboard + Validierung. */
export const CONFIG_KEYS: {
  key: keyof RiskLimits;
  label: string;
  unit: "%" | "x" | "count" | "bool" | "rr";
  description: string;
}[] = [
  { key: "maxPositionPct", label: "Max. Positionsgröße", unit: "%", description: "Max. Anteil des Gesamtkapitals in einer Position." },
  { key: "maxRiskPerTrade", label: "Max. Risiko pro Trade", unit: "%", description: "Kapitalrisiko zwischen Einstieg und Stop-Loss." },
  { key: "maxConcurrentPositions", label: "Max. offene Positionen", unit: "count", description: "So viele Positionen dürfen parallel offen sein." },
  { key: "allowShort", label: "Shorts erlauben", unit: "bool", description: "Leerverkäufe freischalten (Paper!). Standard: aus." },
  { key: "maxLeverage", label: "Max. Hebel", unit: "x", description: "1 = kein Hebel." },
  { key: "defaultStopLossPct", label: "Standard-Stop-Loss", unit: "%", description: "Gilt, wenn Agent/ATR keinen Stop liefern." },
  { key: "maxEquityDrawdownPct", label: "Drawdown-Kill-Schwelle", unit: "%", description: "Ab diesem Gesamt-Drawdown zieht der Not-Halt automatisch." },
  { key: "dailyLossLimitPct", label: "Tagesverlust-Limit", unit: "%", description: "Auto-Kill für den Rest des Tages bei Überschreiten." },
  { key: "takeProfitRR", label: "Take-Profit (R-Multiple)", unit: "rr", description: "TP = Stop-Distanz × diesem Vielfachen." },
  { key: "atrStopMultiplier", label: "ATR-Stopp-Faktor", unit: "x", description: "Dynamischer Stop = ATR × Faktor, wenn Agent keinen angibt." },
];

let loadPromise: Promise<void> | null = null;

/** Aus der DB laden und wirksam setzen (mit kurzem Cache gegen Hot-Looping). */
export async function refreshRuntimeLimits(force = false): Promise<void> {
  if (!force && GLOBAL.__riskCfgLoadedAt && Date.now() - GLOBAL.__riskCfgLoadedAt < RELOAD_TTL_MS) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const rows = await db.select().from(riskConfig);
    const raw: Record<string, number> = {};
    for (const r of rows) {
      const n = Number(r.value);
      if (Number.isFinite(n)) raw[r.key] = n;
    }
    applyRuntimeLimits(raw as Partial<RiskLimits>);
    GLOBAL.__riskCfgLoadedAt = Date.now();
  })();

  try {
    await loadPromise;
  } catch {
    /* DB nicht bereit → Code-Defaults bleiben wirksam */
  } finally {
    loadPromise = null;
  }
}

/** Effektive Limits + Ceiling-Fenster für das Dashboard. */
export function effectiveConfigView() {
  const limits = getLimits();
  return CONFIG_KEYS.map(({ key, label, unit, description }) => ({
    key,
    label,
    unit,
    description,
    value: limits[key],
    min: LIMIT_CEILINGS[key][0],
    max: LIMIT_CEILINGS[key][1],
    locked: key === "requireStopLoss",
    defaultValue: DEFAULT_LIMITS[key],
  }));
}

/**
 * Ändert einen Wert (Dashboard/API). Validiert gegen die Ceilings — außerhalb
 * des Fensters wird geklemmt statt abgelehnt, damit der Operator nie einen
 * halben Zustand hinterlässt. Jede Änderung landet revisionssicher im Audit-Log.
 */
export async function setConfigValue(key: string, value: number): Promise<{ ok: boolean; effective?: unknown; error?: string }> {
  const known = CONFIG_KEYS.find((k) => k.key === key);
  if (!known) return { ok: false, error: `Unbekannter Konfigurationsschlüssel: ${key}` };

  const num = Number(value);
  if (!Number.isFinite(num)) return { ok: false, error: "Wert ist keine Zahl" };

  const before = getLimits()[known.key];
  applyRuntimeLimits({ [key]: num } as Partial<RiskLimits>);
  const after = getLimits()[known.key];
  GLOBAL.__riskCfgLoadedAt = Date.now();

  await db
    .insert(riskConfig)
    .values({ key, value: String(after), description: known.description })
    .onConflictDoUpdate({
      target: riskConfig.key,
      set: { value: String(after), updatedAt: new Date() },
    });

  if (String(before) !== String(after)) {
    await logAudit("CONFIG_CHANGED", "WARN", {
      key,
      before,
      after,
      clamped: String(num) !== String(after),
      requested: num,
      source: "dashboard",
    });
  }
  return { ok: true, effective: after };
}
