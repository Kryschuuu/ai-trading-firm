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
import { applyRuntimeLimits, getBaseLimits, getLimits, DEFAULT_LIMITS, LIMIT_CEILINGS, type RiskLimits } from "./riskGuard";
import { logAudit } from "./engine";
import {
  DEFAULT_VOLATILITY_CONFIG,
  VOLATILITY_CONFIG_BOUNDS,
  VOLATILITY_KEYS,
  applyVolatilityConfig,
  currentVolatilityConfig,
  updateAdaptiveRisk,
  type VolatilityConfig,
} from "./adaptiveRisk";

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

export type ConfigEntryView = {
  key: string;
  label: string;
  unit: "%" | "x" | "count" | "bool" | "rr" | "idx";
  description: string;
  value: number | boolean;
  min: number;
  max: number;
  locked: boolean;
  defaultValue: number | boolean;
};

/**
 * Effektive Limits + Ceiling-Fenster für das Dashboard. Zwei Namensräume:
 * `limits` (klassische Risk-Limits) und `volatility` (adaptives
 * Volatilitäts-System, Keys `adp.*`).
 */
export function effectiveConfigView(): { limits: ConfigEntryView[]; volatility: ConfigEntryView[] } {
  const limits = getLimits();
  const limitsView: ConfigEntryView[] = CONFIG_KEYS.map(({ key, label, unit, description }) => ({
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

  const cfg = currentVolatilityConfig();
  const volView: ConfigEntryView[] = VOLATILITY_KEYS.map(({ key, field, label, unit, description }) => ({
    key,
    label,
    unit,
    description,
    value: cfg[field],
    min: VOLATILITY_CONFIG_BOUNDS[field][0],
    max: VOLATILITY_CONFIG_BOUNDS[field][1],
    locked: false,
    defaultValue: DEFAULT_VOLATILITY_CONFIG[field],
  }));

  return { limits: limitsView, volatility: volView };
}

/**
 * KORRIGIERT (v1.7.0): Prozent-Units normalisieren. Das Dashboard sendet
 * für Unit "%" die PROZENTZahl (Eingabe 30 = 30 %), die internen Limits
 * speichern aber Bruchzahlen (0.30). Vorher fehlte die Division — eine
 * Eingabe von 30 wurde auf das Code-Ceiling geklemmt und damit stumm
 * verfälscht (z. B. maxPositionPct 30 → 0.5 statt 0.3).
 */
const asFraction = (num: number, unit: string): number => (unit === "%" ? num / 100 : num);

/**
 * Ändert einen Wert (Dashboard/API). Gültig für beide Namensräume:
 *   - klassische Risk-Limits (Ceilings: LIMIT_CEILINGS in riskGuard.ts)
 *   - Volatilitäts-System (Keys `adp.*`, Fenster: VOLATILITY_CONFIG_BOUNDS)
 * Außerhalb des Fensters wird geklemmt statt abgelehnt, damit der Operator
 * nie einen halben Zustand hinterlässt. Jede Änderung landet
 * revisionssicher im Audit-Log.
 */
export async function setConfigValue(key: string, value: number): Promise<{ ok: boolean; effective?: unknown; error?: string }> {
  const num = Number(value);
  if (!Number.isFinite(num)) return { ok: false, error: "Wert ist keine Zahl" };

  // ── Namensraum 1: klassische Risk-Limits ──
  const known = CONFIG_KEYS.find((k) => k.key === key);
  if (known) {
    const fraction = asFraction(num, known.unit);
    const before = getBaseLimits()[known.key];
    applyRuntimeLimits({ [key]: fraction } as Partial<RiskLimits>);
    const baseAfter = getBaseLimits()[known.key];
    const after = getLimits()[known.key]; // ggf. weiter adaptiv reduziert

    await db
      .insert(riskConfig)
      .values({ key, value: toDbValue(baseAfter), description: known.description })
      .onConflictDoUpdate({
        target: riskConfig.key,
        set: { value: toDbValue(baseAfter), updatedAt: new Date() },
      });
    GLOBAL.__riskCfgLoadedAt = Date.now();

    if (String(before) !== String(baseAfter)) {
      await logAudit("CONFIG_CHANGED", "WARN", {
        key,
        before,
        after: baseAfter,
        effective: after,
        clamped: String(fraction) !== String(baseAfter),
        requested: num,
        namespace: "limits",
        source: "dashboard",
      });
    }
    return { ok: true, effective: after };
  }

  // ── Namensraum 2: adaptives Volatilitäts-System (adp.*) ──
  const volKey = VOLATILITY_KEYS.find((k) => k.key === key);
  if (volKey) {
    const fraction = asFraction(num, volKey.unit);
    const before = currentVolatilityConfig()[volKey.field];
    applyVolatilityConfig({ [volKey.field]: fraction } as Partial<Record<keyof VolatilityConfig, number | boolean>>);
    const cfgAfter = currentVolatilityConfig();
    const after = cfgAfter[volKey.field];

    await db
      .insert(riskConfig)
      .values({ key, value: toDbValue(after), description: volKey.description })
      .onConflictDoUpdate({
        target: riskConfig.key,
        set: { value: toDbValue(after), updatedAt: new Date() },
      });
    GLOBAL.__riskCfgLoadedAt = Date.now();

    if (String(before) !== String(after)) {
      await logAudit("CONFIG_CHANGED", "WARN", {
        key,
        before,
        after,
        clamped: String(fraction) !== String(after),
        requested: num,
        namespace: "volatility",
        source: "dashboard",
      });
    }

    // Mit der neuen Konfiguration sofort neu bewerten (Best-Effort; bei
    // Netzwerk-Problem greift der nächste Tick innerhalb von 60 s).
    void updateAdaptiveRisk({ force: true }).catch(() => {});
    return { ok: true, effective: after };
  }

  return { ok: false, error: `Unbekannter Konfigurationsschlüssel: ${key}` };
}
