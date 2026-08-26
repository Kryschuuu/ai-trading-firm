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

/**
 * DB-sichere Darstellung: Die Spalte `risk_config.value` ist NUMERIC.
 * Boolesche Limits (z. B. allowShort) werden daher als 0/1 persistiert —
 * `String(true)` = "true" würde PostgreSQL verweigern (22P02: invalid
 * input syntax for type numeric). KORRIGIERT (v1.6.1).
 */
const toDbValue = (v: number | boolean): string =>
  String(typeof v === "boolean" ? (v ? 1 : 0) : v);

/** Robuste Lese-Seite: akzeptiert 0/1 sowie (Legacy) "true"/"false". */
const fromDbValue = (v: unknown): number | null => {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  if (s === "true" || s === "1") return 1;
  if (s === "false" || s === "0") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Aus der DB laden und wirksam setzen (mit kurzem Cache gegen Hot-Looping). */
export async function refreshRuntimeLimits(force = false): Promise<void> {
  if (!force && GLOBAL.__riskCfgLoadedAt && Date.now() - GLOBAL.__riskCfgLoadedAt < RELOAD_TTL_MS) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const rows = await db.select().from(riskConfig);
    const raw: Record<string, number> = {};
    for (const r of rows) {
      const n = fromDbValue(r.value);
      if (n !== null) raw[r.key] = n;
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

  // KORRIGIERT (v1.6.1): Boolesche Limits als 0/1 statt "true"/"false"
  // persistieren — value ist eine NUMERIC-Spalte (Postgres-Fehler 22P02).
  await db
    .insert(riskConfig)
    .values({ key, value: toDbValue(after), description: known.description })
    .onConflictDoUpdate({
      target: riskConfig.key,
      set: { value: toDbValue(after), updatedAt: new Date() },
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
