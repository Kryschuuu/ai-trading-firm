/**
 * ADAPTIVES RISK-LIMIT-SYSTEM — volatilitätsgetriebene Anpassung von maxRiskPerTrade.
 *
 * Problem: Das Risikobudget pro Trade war ein einziger konfigurierter Wert
 * (Standard 2 %). In hochvolatilen Marktphasen (VIX > 30, ATR-/Bollinger-Spikes)
 * entspricht dieselbe 2 % aber einem deutlich größeren absoluten Risiko.
 * Dieses Modul SENKT maxRiskPerTrade deshalb automatisch — ohne Rebuild,
 * ohne Neustart, zur Laufzeit beobachtbar und konfigurierbar.
 *
 * Dreistufige Architektur (Sandbox-Prinzip aus riskGuard.ts bleibt bestehen):
 *
 *   Code-Ceilings (LIMIT_CEILINGS in riskGuard.ts)   ← absolute, hartkodiert
 *      └─ Basis-Limit (risk_config, Dashboard/API)    ← Operator konfiguriert, z. B. 2 %
 *           └─ ADAPTIVER FAKTOR (dieses Modul)        ← Markt volatilitätsgetrieben,
 *                kann nur SENKEN (Faktor ∈ (0, 1]), nie erhöhen
 *
 * Indikatoren (Schwellwerte zur Laufzeit änderbar, Keys `adp.*` in risk_config):
 *   1. VIX        — primärer Trigger. ≥ 30 → ELEVATED, ≥ 40 → EXTREME.
 *   2. ATR %      — Average True Range (14) auf 15-min-Kerzen, Korb-Spitzenwert.
 *   3. BBW %      — Bollinger Band Width (20, 2σ), Korb-Spitzenwert.
 *   4. Return-Std — Standardabweichung der Returns (20 × 15-min), Korb-Spitzenwert.
 *
 * Regime-Logik (deterministisch, siehe assessRegime()):
 *   EXTREME  wenn VIX ≥ vixExtreme
 *             ODER (VIX ≥ vixHigh UND ≥ 1 weiterer Indikator getriggert)
 *             ODER (alle 3 Korb-Indikatoren getriggert)
 *   ELEVATED wenn VIX ≥ vixHigh ODER ≥ 1 Korb-Indikator getriggert
 *   NORMAL   sonst
 *
 * Anti-Flapping (schnelle Volatilitätswechsel): Eskalation ist sofort
 * (sichere Richtung), DE-Eskalation erst nach `deescalateAfter`
 * konsekutiven ruhigen Bewertungen (Standard: 3 Ticks ≈ 3 Minuten).
 *
 * Fehlende Daten (fail-closed seit H10/v1.36.21): Eine einzelne Indikator-
 * Quelle ohne Daten triggert im reinen Bewertungskern (assessRegime) NIE —
 * dort entscheidet allein die Regime-Matrix über die verfügbaren Werte.
 * Die ORCHESTRIERUNG (updateAdaptiveRisk) wertet fehlende/fehlerhafte/
 * veraltete Bewertungen aber als expliziten UNKNOWN-Zustand: Faktor auf dem
 * konservativen Code-Boden, keine neuen Positionen — statt still auf volles
 * Basisrisiko (Fail-Open) zurückzufallen.
 *
 * Risiko kann durch fehlende Daten niemals ERHÖHT werden (Faktor ≤ 1).
 *
 * Observability (für Agenten + Monitoring):
 *   - GET  /api/firm/risk/volatility  → Status, Indikatoren, Event-Historie
 *   - POST /api/firm/risk/volatility  → sofortige Neubewertung erzwingen
 *   - Audit-Log-Events `RISK_ADAPTIVE` bei jeder Regime-/Limit-Änderung
 *   - In-Memory-Ring-Buffer der letzten 50 Trigger-Events
 *   - Aktiver Faktor wird persistiert (adp.activeFactor / adp.activeAt),
 *     damit der separate Mikro-Executor-Prozess die Reduktion ebenfalls sieht.
 */
import { db } from "@/db";
import { riskConfig } from "@/db/schema";
import { getCandles, type Candle } from "./marketData";
import { atrPct, bollingerBandWidthPct, returnStdDevPct } from "./indicators";
import { auditWrite } from "./auditSink";
import {
  ADAPTIVE_STATE_MAX_AGE_MS,
  LIMIT_CEILINGS,
  applyAdaptiveRisk,
  getBaseLimits,
  getLimits,
} from "./riskGuard";
import type { AdaptiveRegime } from "./riskGuard";

// ─────────────────────────────────────────────────────────────────────────────
// Konstanten
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Volatilitäts-Korb für die Korb-Indikatoren: Aktien-Index (SPY/QQQ =
 * VIX-Basis-Asset) plus BTC als 24/7-Proxy. Fester Korb im Code, weil die
 * risk_config-Spalte nur NUMERIC trägt; die Schwellwerte bleiben frei
 * konfigurierbar.
 */
export const VOLATILITY_BASKET = ["SPY", "QQQ", "BTC"] as const;

export const VOLATILITY_CANDLE_INTERVAL = "15m";
export const VOLATILITY_CANDLE_LIMIT = 90; // 90 × 15 min = 2,5 Tage Historie
export const VOLATILITY_ATR_PERIOD = 14;
export const VOLATILITY_BOLL_PERIOD = 20;
export const VOLATILITY_BOLL_MULT = 2;
export const VOLATILITY_STDDEV_PERIOD = 20;

/** Mindest-Abstand zwischen zwei Neubewertungen (Scheduler-Takt ≈ 60 s). */
export const UPDATE_MIN_INTERVAL_MS = 45_000;
/** Status gilt als "stale", wenn die letzte Bewertung älter ist. */
export const STATUS_STALE_MS = 5 * 60_000;
/** Cache für den VIX-Wert (Yahoo liefert 1d-Kerzen; 5 Min sind frisch genug). */
export const VIX_CACHE_TTL_MS = 5 * 60_000;
/** TTL für das Nachladen der Volatilitäts-Konfiguration aus der DB. */
export const CONFIG_RELOAD_TTL_MS = 10_000;
/** Länge des In-Memory-Event-Ring-Buffer. */
export const EVENT_HISTORY_LENGTH = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration (zur Laufzeit änderbar, Keys `adp.*` in risk_config)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schwellwerte und Faktoren. Prozentbasierte Werte sind DEZIMAL
 * (0.01 = 1 %) — konsistent mit den übrigen Risk-Limits.
 */
export type VolatilityConfig = {
  /** Master-Schalter: false → System bleibt inaktiv (Faktor immer 1). */
  enabled: boolean;
  /** Primärer Trigger: VIX ≥ Wert → mindestens ELEVATED. */
  vixHigh: number;
  /** VIX ≥ Wert → direkt EXTREME. */
  vixExtreme: number;
  /** ATR (14, 15-min) in Bruchteil des Kurses, ab der der Indikator triggt. */
  atrHigh: number;
  /** Bollinger-Band-Breite (20, 2σ) in Bruchteil des Kurses. */
  bbwHigh: number;
  /** Return-Standardabweichung (20 Perioden) in Bruchteil pro Periode. */
  retStdDevHigh: number;
  /** Multiplikator für maxRiskPerTrade im ELEVATED-Regime (0.5 = halbiert). */
  elevatedFactor: number;
  /** Multiplikator im EXTREME-Regime (0.25 = viertelt). */
  extremeFactor: number;
  /** Anzahl konsekutiver ruhiger Bewertungen bis zur De-Eskalation. */
  deescalateAfter: number;
};

/** Werkwerte — zugleich Sinnvolle-Standardwerte, änderbar ohne Rebuild. */
export const DEFAULT_VOLATILITY_CONFIG: VolatilityConfig = {
  enabled: true,
  vixHigh: 30, // VIX > 30 = etablierter "hohe Angst"-Punkt
  vixExtreme: 40, // VIX > 40 = Krisenlevel (z. B. 2020, 2022)
  atrHigh: 0.01, // ATR 15-min > 1 % des Kurses = deutlich erhöht
  bbwHigh: 0.05, // Bollinger-Band > 5 % breit = Bands aufgeplatzt
  retStdDevHigh: 0.01, // Return-StdDev > 1 % pro 15-min-Kerze
  elevatedFactor: 0.5, // 2 % → 1 %
  extremeFactor: 0.25, // 2 % → 0.5 %
  deescalateAfter: 3, // 3 ruhige Ticks (~3 Min) bis zurück
};

/** Erlaubtes Fenster pro Schlüssel — DB/Dashboard-Werte werden geklemmt. */
export const VOLATILITY_CONFIG_BOUNDS: Record<keyof VolatilityConfig, [min: number, max: number]> = {
  enabled: [0, 1],
  vixHigh: [5, 80],
  vixExtreme: [5, 120],
  atrHigh: [0.0005, 0.2],
  bbwHigh: [0.002, 0.5],
  retStdDevHigh: [0.0005, 0.2],
  elevatedFactor: [0.05, 1],
  extremeFactor: [0.02, 1],
  deescalateAfter: [1, 10],
};

/** DB-Key ↔ Config-Feld (die Spalte risk_config.value ist NUMERIC). */
const DB_KEY_BY_FIELD: Record<keyof VolatilityConfig, string> = {
  enabled: "adp.enabled",
  vixHigh: "adp.vixHigh",
  vixExtreme: "adp.vixExtreme",
  atrHigh: "adp.atrHighPct",
  bbwHigh: "adp.bbwHighPct",
  retStdDevHigh: "adp.retStdDevHighPct",
  elevatedFactor: "adp.elevatedFactor",
  extremeFactor: "adp.extremeFactor",
  deescalateAfter: "adp.deescalateAfter",
};
const FIELD_BY_DB_KEY: Record<string, keyof VolatilityConfig> = Object.fromEntries(
  (Object.entries(DB_KEY_BY_FIELD) as [keyof VolatilityConfig, string][]).map(([f, k]) => [k, f])
);

/** Metadaten für Dashboard, Seed und Validierung. */
export const VOLATILITY_KEYS: {
  key: string;
  field: keyof VolatilityConfig;
  label: string;
  unit: "idx" | "%" | "x" | "count" | "bool";
  description: string;
}[] = [
  { key: "adp.enabled", field: "enabled", label: "Adaptive Risikoreduktion", unit: "bool", description: "Volatilitätsgetriebene Senkung von maxRiskPerTrade an/aus." },
  { key: "adp.vixHigh", field: "vixHigh", label: "VIX-Schwelle (erhöht)", unit: "idx", description: "Ab diesem VIX-Wert: ELEVATED (primärer Trigger). Standard 30." },
  { key: "adp.vixExtreme", field: "vixExtreme", label: "VIX-Schwelle (extrem)", unit: "idx", description: "Ab diesem VIX-Wert: direkt EXTREME. Standard 40." },
  { key: "adp.atrHighPct", field: "atrHigh", label: "ATR-Schwelle", unit: "%", description: "ATR (14) auf 15-min-Kerzen in % des Kurses. Eingabe z. B. 1 = 1 %." },
  { key: "adp.bbwHighPct", field: "bbwHigh", label: "Bollinger-Band-Schwelle", unit: "%", description: "Bandbreite (20, 2σ) in % des Kurses. Eingabe z. B. 5 = 5 %." },
  { key: "adp.retStdDevHighPct", field: "retStdDevHigh", label: "Return-StdDev-Schwelle", unit: "%", description: "StdDev der Returns (20 × 15-min) in % pro Kerze. Eingabe z. B. 1 = 1 %." },
  { key: "adp.elevatedFactor", field: "elevatedFactor", label: "Faktor ELEVATED", unit: "x", description: "Multiplikator für maxRiskPerTrade (0.5 = halbiert)." },
  { key: "adp.extremeFactor", field: "extremeFactor", label: "Faktor EXTREME", unit: "x", description: "Multiplikator für maxRiskPerTrade (0.25 = viertelt)." },
  { key: "adp.deescalateAfter", field: "deescalateAfter", label: "De-Eskalation nach", unit: "count", description: "Anzahl konsekutiver ruhiger Ticks, bis das Limit wieder ansteigt." },
];

/**
 * Klemmt eine Partial-Konfiguration in das erlaubte Fenster. Fehlende oder
 * ungültige Werte behalten den aktuellen (bzw. Default-)Wert. Boolesche
 * kommen aus DB/Dashboard als 0/1 (NUMERIC-Spalte).
 */
export function clampVolatilityConfig(
  raw: Partial<Record<keyof VolatilityConfig, number | boolean>>,
  base: VolatilityConfig = DEFAULT_VOLATILITY_CONFIG
): VolatilityConfig {
  const next: VolatilityConfig = { ...base };
  for (const field of Object.keys(DEFAULT_VOLATILITY_CONFIG) as (keyof VolatilityConfig)[]) {
    const v = raw[field];
    if (v === undefined || v === null) continue;
    const num = typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
    if (!Number.isFinite(num)) continue;
    const [min, max] = VOLATILITY_CONFIG_BOUNDS[field];
    const clamped = Math.min(Math.max(num, min), max);
    if (field === "enabled") next.enabled = clamped >= 0.5;
    else if (field === "deescalateAfter") next.deescalateAfter = Math.round(clamped);
    else (next[field] as number) = clamped;
  }
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reine Logik: Bewertungen + Hysterese (unit-testbar, kein I/O)
// ─────────────────────────────────────────────────────────────────────────────

/** Namen der vier Indikatoren (stabil für API/Logs). */
export type IndicatorName = "VIX" | "ATR" | "BBW" | "RET_STDDEV";

export const INDICATOR_LABELS: Record<IndicatorName, string> = {
  VIX: "CBOE VIX (Angst-Index)",
  ATR: "ATR 14 · 15-min (Korb-Spitze)",
  BBW: "Bollinger Band Width 20/2σ · 15-min (Korb-Spitze)",
  RET_STDDEV: "StdDev Returns 20×15-min (Korb-Spitze)",
};

/** Rohe Messwerte (null = Quelle aktuell nicht verfügbar). Dezimal, nicht Prozent. */
export type IndicatorReadings = {
  vix: number | null;
  atr: number | null;
  bbw: number | null;
  retStdDev: number | null;
};

export type IndicatorReading = {
  name: IndicatorName;
  label: string;
  /** Gemessener Wert (dezimal; im API als solcher geliefert). null = ohne Daten. */
  value: number | null;
  threshold: number;
  available: boolean;
  triggered: boolean;
};

export type VolatilityRegime = "NORMAL" | "ELEVATED" | "EXTREME";

export type RegimeAssessment = {
  regime: VolatilityRegime;
  /** Multiplikator, der zum Basis-Limit gerechnet wird (NORMAL = 1). */
  factor: number;
  indicators: IndicatorReading[];
  /** Namen der getriggerten Indikatoren (leer bei NORMAL). */
  triggered: string[];
  /** Menschen- und Agenten-lesbare Begründung. */
  reason: string;
};

/** Nur endliche, nicht-negative Zahlen gelten als Messwert (sonst null = nicht verfügbar). */
const clean = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

const regimeFactor = (regime: VolatilityRegime, cfg: VolatilityConfig): number =>
  regime === "EXTREME" ? cfg.extremeFactor : regime === "ELEVATED" ? cfg.elevatedFactor : 1;

/**
 * H10 (v1.36.21): UNKNOWN-Bestimmung — fehlende, fehlerhafte oder zu alte
 * Bewertung ist ein EIGENER Zustand, kein stiller NORMAL-Fallback.
 *
 * - MISSING: noch nie eine Bewertung gelaufen.
 * - ERRORED: letzte Bewertung lief mit Fehlern (Quellen-Timeout o. ä.).
 * - STALE:   letzte Bewertung älter als ADAPTIVE_STATE_MAX_AGE_MS.
 */
export type AdaptiveUnknownCause = "MISSING" | "ERRORED" | "STALE";

export function resolveAdaptiveUnknown(
  lastAssessment: RegimeAssessment | null,
  lastError: string | null,
  lastUpdateAt: number | null,
  now: number = Date.now(),
  maxAgeMs: number = ADAPTIVE_STATE_MAX_AGE_MS
): AdaptiveUnknownCause | null {
  if (lastAssessment == null) return "MISSING";
  if (lastError != null) return "ERRORED";
  if (lastUpdateAt == null || now - lastUpdateAt > maxAgeMs) return "STALE";
  return null;
}

/**
 * Konservativster Faktor für UNKNOWN: klemmt das wirksame maxRiskPerTrade
 * auf den absoluten Code-Boden (LIMIT_CEILINGS.maxRiskPerTrade[0]).
 */
export function adaptiveUnknownFactor(baseMaxRiskPerTrade: number): number {
  const floor = LIMIT_CEILINGS.maxRiskPerTrade[0];
  if (!Number.isFinite(baseMaxRiskPerTrade) || baseMaxRiskPerTrade <= 0) return 1;
  return Math.min(Math.max(floor / baseMaxRiskPerTrade, 0), 1);
}

function unknownReason(cause: AdaptiveUnknownCause, lastError: string | null): string {
  switch (cause) {
    case "MISSING":
      return "Keine Bewertung vorhanden — Regime UNKNOWN: keine neuen Positionen (fail-closed)";
    case "ERRORED":
      return `Adaptive-Bewertung fehlgeschlagen: ${lastError ?? "unbekannter Fehler"} — Regime UNKNOWN: keine neuen Positionen`;
    case "STALE":
      return `Bewertung älter als ADAPTIVE_STATE_MAX_AGE_MS (${Math.round(ADAPTIVE_STATE_MAX_AGE_MS / 60_000)} min) — Regime UNKNOWN: keine neuen Positionen (fail-closed)`;
  }
}

/**
 * Bewertet einen Markt-Zustand deterministisch (reine Funktion — der Kern
 * des Systems, in den Unit-Tests vollständig abgesichert).
 *
 * Regime-Regeln (siehe Modul-Kopf):
 *   EXTREME:  VIX ≥ vixExtreme  ODER  (VIX ≥ vixHigh UND ≥ 1 Korbitrigger)
 *             ODER  alle 3 Korb-Indikatoren getriggert
 *   ELEVATED: VIX ≥ vixHigh  ODER  ≥ 1 Korb-Indikator getriggert
 *
 * Misskonfigurations-Schutz: vixExtreme muss strikt über vixHigh liegen,
 * sonst ist der direkte EXTREME-Trigger inaktiv (konservativ: nur
 * VIX-Hoch → ELEVATED, mit Korb-Bestätigung → EXTREME).
 */
export function assessRegime(readingsRaw: IndicatorReadings, cfg: VolatilityConfig): RegimeAssessment {
  const vix = clean(readingsRaw.vix);
  const atr = clean(readingsRaw.atr);
  const bbw = clean(readingsRaw.bbw);
  const rsd = clean(readingsRaw.retStdDev);

  const enabled = cfg.enabled;
  const effVixExtreme = Math.max(cfg.vixHigh, cfg.vixExtreme);
  // Misskonfigurations-Schutz: vixExtreme muss strikt ÜBER vixHigh liegen,
  // damit es ein eigenes Extrem-Level bleibt. Gleichstand (oder vixExtreme
  // < vixHigh) deaktiviert den direkten EXTREME-Trigger — VIX-Hoch ergibt
  // dann maximal ELEVATED und wird nur mit Korb-Bestätigung auf EXTREME
  // eskaliert (konservative Interpretation statt Stufen-Sprung).
  const extremeLevelValid = effVixExtreme > cfg.vixHigh;

  const vixHit = enabled && vix != null && vix >= cfg.vixHigh;
  const vixExtremeHit = extremeLevelValid && enabled && vix != null && vix >= effVixExtreme;
  const atrHit = enabled && atr != null && atr >= cfg.atrHigh;
  const bbwHit = enabled && bbw != null && bbw >= cfg.bbwHigh;
  const rsdHit = enabled && rsd != null && rsd >= cfg.retStdDevHigh;
  const basketHits = [atrHit, bbwHit, rsdHit].filter(Boolean).length;

  let regime: VolatilityRegime = "NORMAL";
  if (vixExtremeHit || (vixHit && basketHits >= 1) || basketHits >= 3) regime = "EXTREME";
  else if (vixHit || basketHits >= 1) regime = "ELEVATED";

  const indicators: IndicatorReading[] = [
    { name: "VIX", label: INDICATOR_LABELS.VIX, value: vix, threshold: cfg.vixHigh, available: vix != null, triggered: vixHit || vixExtremeHit },
    { name: "ATR", label: INDICATOR_LABELS.ATR, value: atr, threshold: cfg.atrHigh, available: atr != null, triggered: atrHit },
    { name: "BBW", label: INDICATOR_LABELS.BBW, value: bbw, threshold: cfg.bbwHigh, available: bbw != null, triggered: bbwHit },
    { name: "RET_STDDEV", label: INDICATOR_LABELS.RET_STDDEV, value: rsd, threshold: cfg.retStdDevHigh, available: rsd != null, triggered: rsdHit },
  ];

  const triggered = indicators.filter((i) => i.triggered).map((i) => i.name);
  const pct = (v: number | null, t: number) => `${v != null ? (v * 100).toFixed(2) : "n/v"} % (Schwelle ${t * 100} %)`;

  let reason: string;
  if (!enabled) reason = "Adaptive Risikoreduktion deaktiviert (adp.enabled = 0)";
  else if (regime === "NORMAL") {
    const none = indicators.every((i) => !i.available);
    reason = none
      ? "Keine Indikator-Daten verfügbar — Regime nicht bewertbar (verarbeitet als UNKNOWN, keine neuen Positionen)"
      : "Alle Indikatoren unter den Schwellwerten";
  } else {
    const parts: string[] = [];
    if (vixExtremeHit) parts.push(`VIX ${vix!.toFixed(1)} ≥ ${effVixExtreme} (extrem)`);
    else if (vixHit) parts.push(`VIX ${vix!.toFixed(1)} ≥ ${cfg.vixHigh} (primärer Trigger)`);
    if (atrHit) parts.push(`ATR ${pct(atr, cfg.atrHigh)}`);
    if (bbwHit) parts.push(`BBW ${pct(bbw, cfg.bbwHigh)}`);
    if (rsdHit) parts.push(`Return-StdDev ${pct(rsd, cfg.retStdDevHigh)}`);
    reason = parts.join(", ");
  }

  return { regime, factor: regimeFactor(regime, cfg), indicators, triggered, reason };
}

const REGIME_SEVERITY: Record<VolatilityRegime, number> = { NORMAL: 0, ELEVATED: 1, EXTREME: 2 };

/**
 * Regime-Hysterese gegen Flapping bei schnellen Volatilitätswechseln.
 *
 * - Eskalation (NORMAL → ELEVATED → EXTREME): SOFORT — die sichere Richtung.
 * - Gleichbleiben: Streak zurücksetzen.
 * - De-Eskalation: erst nach `deescalateAfter` konsekutiven Bewertungen mit
 *   niedrigerer Schwere (direkter Sprung auf das Kandidaten-Regime).
 *
 * Reine Klasse ohne I/O — im Test mit Sequenzen beliebig simulierbar.
 */
export class RegimeStateMachine {
  private current: VolatilityRegime = "NORMAL";
  private calmStreak = 0;

  get regime(): VolatilityRegime {
    return this.current;
  }
  get streak(): number {
    return this.calmStreak;
  }

  reset(): void {
    this.current = "NORMAL";
    this.calmStreak = 0;
  }

  update(candidate: VolatilityRegime, deescalateAfter: number): { regime: VolatilityRegime; changed: boolean } {
    const need = Math.max(1, Math.trunc(deescalateAfter) || 1);
    const c = REGIME_SEVERITY[candidate];
    const cur = REGIME_SEVERITY[this.current];

    if (c > cur) {
      this.current = candidate; // sofort eskalieren
      this.calmStreak = 0;
      return { regime: this.current, changed: true };
    }
    if (c === cur) {
      this.calmStreak = 0; // Bedingung hält an → Streak bricht ab
      return { regime: this.current, changed: false };
    }
    this.calmStreak += 1;
    if (this.calmStreak >= need) {
      this.current = candidate; // De-Eskalation (mehrstufig möglich)
      this.calmStreak = 0;
      return { regime: this.current, changed: true };
    }
    return { regime: this.current, changed: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Markt-Daten: VIX + Korb-Indikatoren (Default-Fetcher, injizierbar für Tests)
// ─────────────────────────────────────────────────────────────────────────────

type FetcherDeps = {
  fetchVix?: () => Promise<number | null>;
  fetchCandles?: (symbol: string) => Promise<Candle[]>;
};

let vixCache: { value: number; ts: number } | null = null;

/**
 * VIX über Yahoo Finance (^VIX). 5-Min-Cache, zwei Hosts als Fallback,
 * Stale-Cache bei Fehlschlag (letzter bekannter Wert ist besser als keiner).
 * Liefert null, wenn nie ein Wert verfügbar war.
 */
export async function fetchVix(): Promise<number | null> {
  if (vixCache && Date.now() - vixCache.ts < VIX_CACHE_TTL_MS) return vixCache.value;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(
          `https://${host}/v8/finance/chart/%5EVIX?range=1d&interval=1d`,
          { signal: ctrl.signal, cache: "no-store" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          chart?: { result?: { meta?: { regularMarketPrice?: number }; indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
        };
        const result = data?.chart?.result?.[0];
        const meta = Number(result?.meta?.regularMarketPrice);
        const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => c != null);
        const vix = Number.isFinite(meta) && meta > 0 ? meta : closes[closes.length - 1];
        if (Number.isFinite(vix) && vix > 0 && vix < 300) {
          vixCache = { value: vix, ts: Date.now() };
          return vix;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* nächster Host */
    }
  }
  return vixCache?.value ?? null;
}

/**
 * Liest alle vier Indikatorwerte. Fehlgeschlagene Quellen landen in
 * `errors` und liefern null — der Aufrufer wertet Fehler/leere Quellen
 * seit H10/v1.36.21 als UNKNOWN (fail-closed), statt still auf NORMAL zu
 * fallen. Korb-Indikatoren: SPITZENWERT über den Korb (das volatilste Mitglied
 * dominiert das Risikobild).
 */
export async function readMarketReadings(deps: FetcherDeps = {}): Promise<{
  readings: IndicatorReadings;
  errors: string[];
}> {
  const fetchVixFn = deps.fetchVix ?? fetchVix;
  const fetchCandlesFn =
    deps.fetchCandles ?? ((s: string) => getCandles(s, VOLATILITY_CANDLE_INTERVAL, VOLATILITY_CANDLE_LIMIT));
  const errors: string[] = [];

  let vix: number | null = null;
  try {
    vix = await fetchVixFn();
  } catch (e) {
    errors.push(`VIX: ${e instanceof Error ? e.message : e}`);
  }

  const basket = await Promise.all(
    (VOLATILITY_BASKET as readonly string[]).map(async (symbol) => {
      try {
        const candles = await fetchCandlesFn(symbol);
        const closes = candles.map((c) => c.close);
        return {
          symbol,
          atr: atrPct(candles, VOLATILITY_ATR_PERIOD),
          bbw: bollingerBandWidthPct(closes, VOLATILITY_BOLL_PERIOD, VOLATILITY_BOLL_MULT),
          retStdDev: returnStdDevPct(closes, VOLATILITY_STDDEV_PERIOD),
        };
      } catch (e) {
        errors.push(`${symbol}: ${e instanceof Error ? e.message : e}`);
        return { symbol, atr: null, bbw: null, retStdDev: null };
      }
    })
  );

  const peak = (vals: (number | null)[]): number | null => {
    const ok = vals.filter((v): v is number => v != null && Number.isFinite(v) && v >= 0);
    return ok.length > 0 ? Math.max(...ok) : null;
  };

  return {
    readings: {
      vix,
      atr: peak(basket.map((b) => b.atr)),
      bbw: peak(basket.map((b) => b.bbw)),
      retStdDev: peak(basket.map((b) => b.retStdDev)),
    },
    errors,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Laufzeit-Zustand (globalThis: überlebt Next.js-HMR wie der Rest der Firma)
// ─────────────────────────────────────────────────────────────────────────────

export type AdaptiveRiskEvent = {
  at: string;
  prevRegime: AdaptiveRegime;
  regime: AdaptiveRegime;
  factor: number;
  baseMaxRiskPerTrade: number;
  effectiveMaxRiskPerTrade: number;
  triggered: string[];
  reason: string;
};

export type AdaptiveRiskStatus = {
  regime: AdaptiveRegime;
  enabled: boolean;
  /** Aktueller Multiplikator auf das Basis-Limit (1 = keine Reduktion). */
  factor: number;
  /** Aus der Konfiguration (risk_config / Dashboard). */
  baseMaxRiskPerTrade: number;
  /** Tatsächlich wirksam (Basis × Faktor, auf Code-Boden geklemmt). */
  effectiveMaxRiskPerTrade: number;
  lastUpdate: string | null;
  lastChange: string | null;
  lastError: string | null;
  /** true, wenn die letzte Bewertung länger als STATUS_STALE_MS zurückliegt. */
  stale: boolean;
  reason: string;
  indicators: IndicatorReading[];
  /** Jüngste Trigger-Events zuerst (Ring-Buffer, max. EVENT_HISTORY_LENGTH). */
  events: AdaptiveRiskEvent[];
  config: VolatilityConfig;
  bounds: Record<keyof VolatilityConfig, [number, number]>;
};

const G = globalThis as typeof globalThis & {
  __adaptiveRisk?: {
    config: VolatilityConfig;
    configLoadedAt: number;
    machine: RegimeStateMachine;
    lastAssessment: RegimeAssessment | null;
    lastUpdateAt: number | null;
    lastChangeAt: string | null;
    lastError: string | null;
    events: AdaptiveRiskEvent[];
    updating: Promise<AdaptiveRiskStatus> | null;
  };
};

type State = NonNullable<(typeof G)["__adaptiveRisk"]>;

function state(): State {
  G.__adaptiveRisk ??= {
    config: { ...DEFAULT_VOLATILITY_CONFIG },
    configLoadedAt: 0,
    machine: new RegimeStateMachine(),
    lastAssessment: null,
    lastUpdateAt: null,
    lastChangeAt: null,
    lastError: null,
    events: [],
    updating: null,
  };
  return G.__adaptiveRisk;
}

function buildStatus(s: State): AdaptiveRiskStatus {
  const base = getBaseLimits().maxRiskPerTrade;
  // H10 (v1.36.21): Bei aktiviertem Adaptiv-System ist eine fehlende/
  // fehlerhafte/zu alte Bewertung ein eigener Zustand (UNKNOWN), kein stiller
  // NORMAL-Fallback. Deaktivierte Systeme bleiben bewusst unverändert
  // (Operator hat die Reduktion explizit ausgeschaltet → Basis-Regime).
  const cause = s.config.enabled ? resolveAdaptiveUnknown(s.lastAssessment, s.lastError, s.lastUpdateAt) : null;
  const machineRegime = s.machine.regime;
  const regime: AdaptiveRegime = cause == null ? machineRegime : "UNKNOWN";
  const factor = cause == null ? regimeFactor(machineRegime, s.config) : adaptiveUnknownFactor(base);
  const effective = cause == null
    ? getLimits().maxRiskPerTrade
    : Math.max(base * factor, LIMIT_CEILINGS.maxRiskPerTrade[0]);
  return {
    regime,
    enabled: s.config.enabled,
    factor,
    baseMaxRiskPerTrade: base,
    effectiveMaxRiskPerTrade: effective,
    lastUpdate: s.lastUpdateAt ? new Date(s.lastUpdateAt).toISOString() : null,
    lastChange: s.lastChangeAt,
    lastError: s.lastError,
    stale: s.lastUpdateAt == null || Date.now() - s.lastUpdateAt > STATUS_STALE_MS,
    reason: cause == null
      ? (s.lastAssessment?.reason ?? "Noch keine Bewertung erfolgt.")
      : unknownReason(cause, s.lastError),
    indicators: s.lastAssessment?.indicators ?? [],
    events: [...s.events].reverse(),
    config: { ...s.config },
    bounds: { ...VOLATILITY_CONFIG_BOUNDS },
  };
}

/**
 * Lädt die Volatilitäts-Konfiguration aus risk_config (`adp.*`-Zeilen).
 * Fehlende/ungültige Zeilen behalten den aktuellen Wert; DB-Fehler →
 * bestehende Konfiguration bleibt (Fail-Safe).
 */
async function loadConfig(s: State): Promise<VolatilityConfig> {
  try {
    const rows = await db.select().from(riskConfig);
    const raw: Partial<Record<keyof VolatilityConfig, number>> = {};
    for (const r of rows) {
      const field = FIELD_BY_DB_KEY[r.key];
      if (!field) continue;
      const n = Number(r.value);
      if (Number.isFinite(n)) raw[field] = n;
    }
    s.config = clampVolatilityConfig(raw, s.config);
    s.configLoadedAt = Date.now();
    return s.config;
  } catch {
    return s.config; // DB nicht bereit → aktuelle/Default-Konfiguration
  }
}

/** Setzt Volatilitäts-Konfiguration (geklemmt) — von Dashboard/API aufgerufen. */
export function applyVolatilityConfig(partial: Partial<Record<keyof VolatilityConfig, number | boolean>>): VolatilityConfig {
  const s = state();
  s.config = clampVolatilityConfig(partial, s.config);
  s.configLoadedAt = Date.now();
  return s.config;
}

/** Aktuelle (geklemmte) Volatilitäts-Konfiguration. */
export function currentVolatilityConfig(): VolatilityConfig {
  return { ...state().config };
}

/**
 * Audit-Log-Eintrag der adaptiven Risikobewertung.
 *
 * S1 (v1.36.18): Klasse `telemetry` — Volatilitäts-Events sind
 * Beobachtungsdaten, ihr Fehlen blockiert den Risikopfad nicht (Tests ohne DB,
 * DB-Neustart). „best-effort“ heißt hier nicht mehr „still“: ein Fehlschlag
 * zählt in `audit_write_failures_total{auditClass="telemetry"}` und erzeugt
 * eine Warnung im strukturierten Log. Risk-Regime-Wechsel im EXTREME-Fall sind
 * für die Nachvollziehbarkeit relevant, deshalb zusätzlich Spool-Reserve.
 */
async function logAdaptiveEvent(event: AdaptiveRiskEvent, regime: AdaptiveRegime): Promise<void> {
  const alarm = regime === "EXTREME" || regime === "UNKNOWN";
  await auditWrite(
    "RISK_ADAPTIVE",
    alarm ? "WARN" : "INFO",
    event,
    { auditClass: alarm ? "security" : "telemetry" }
  );
}

/**
 * Persistiert den aktiven Faktor (adp.activeFactor / adp.activeAt), damit
 * der SEPARATE Mikro-Executor-Prozess (npm run micro) die Reduktion ohne
 * eigenen Marktzugriff übernehmen kann. Frische-Grenze: ADAPTIVE_STATE_MAX_AGE_MS.
 */
async function persistActiveState(factor: number): Promise<void> {
  try {
    const atSec = Math.floor(Date.now() / 1000);
    for (const [key, value, description] of [
      ["adp.activeFactor", factor, "Aktiver adaptiver Risikofaktor (vom Volatilitäts-Engine geschrieben)"],
      ["adp.activeAt", atSec, "Epoch-Sekunden der letzten adaptiven Risikobewertung"],
    ] as const) {
      await db
        .insert(riskConfig)
        .values({ key, value: String(value), description })
        .onConflictDoUpdate({
          target: riskConfig.key,
          set: { value: String(value), updatedAt: new Date() },
        });
    }
  } catch {
    /* Persistenz ist optional — Main-Prozess bleibt voll funktionsfähig */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Haupt-API
// ─────────────────────────────────────────────────────────────────────────────

export type UpdateOptions = {
  /** Umbgeht das Min-Interval (z. B. nach Konfigurationsänderung, API-POST). */
  force?: boolean;
  /** Min. Abstand zwischen zwei Neubewertungen (Default UPDATE_MIN_INTERVAL_MS). */
  minIntervalMs?: number;
  /** Volle Konfiguration statt DB-Lade (Tests/Overrides). */
  config?: VolatilityConfig;
  /** Vorgefertigte Messwerte — überspringt den Markt-Zugriff komplett. */
  readings?: IndicatorReadings;
  /** Injizierbare Fetcher (Tests). */
  fetchVix?: () => Promise<number | null>;
  fetchCandles?: (symbol: string) => Promise<Candle[]>;
};

/**
 * Führt einen vollständigen Bewertungsdurchlauf aus:
 * Konfiguration → Markt-Daten → Regime-Bewertung → Hysterese →
 * Anwendung in riskGuard → Event + Audit + Persistenz.
 *
 * Single-Flight (kein paralleles Re-Entry) + Min-Interval (Scheduler-Takt).
 * Fehler machen den Durchlauf NIE abbrechen — sie münden seit H10/v1.36.21
 * aber in einen expliziten UNKNOWN-Zustand statt in einen stillen letzten
 * Zustand (fail-closed: Risiko kann nur bleiben oder sinken, nie wachsen).
 */
export async function updateAdaptiveRisk(opts: UpdateOptions = {}): Promise<AdaptiveRiskStatus> {
  const s = state();

  if (s.updating && !opts.force) return s.updating;
  if (
    !opts.force &&
    s.lastUpdateAt != null &&
    Date.now() - s.lastUpdateAt < (opts.minIntervalMs ?? UPDATE_MIN_INTERVAL_MS)
  ) {
    return buildStatus(s);
  }

  const run = (async () => {
    const cfg = opts.config
      ? clampVolatilityConfig(opts.config, s.config)
      : Date.now() - s.configLoadedAt >= CONFIG_RELOAD_TTL_MS
        ? await loadConfig(s)
        : s.config;

    let readings: IndicatorReadings;
    let errors: string[];
    if (opts.readings) {
      readings = opts.readings;
      errors = [];
    } else {
      const res = await readMarketReadings({ fetchVix: opts.fetchVix, fetchCandles: opts.fetchCandles });
      readings = res.readings;
      errors = res.errors;
    }
    const assessment = assessRegime(readings, cfg);
    const base = getBaseLimits().maxRiskPerTrade;
    const at = new Date().toISOString();
    const indicators = { VIX: readings.vix, ATR: readings.atr, BBW: readings.bbw, RET_STDDEV: readings.retStdDev };
    const prevStatusRegime: AdaptiveRegime = s.lastError != null ? "UNKNOWN" : s.machine.regime;

    // H10 (v1.36.21): Liefert KEINE Quelle einen Messwert, ist das Regime
    // nicht bestimmbar — UNKNOWN (fail-closed) statt stillem NORMAL. Nur
    // bei AKTIVIERTEM Adaptiv-System: ein deaktiviertes System ist die
    // bewusste Operator-Entscheidung fürs Basis-Regime.
    const noneAvailable =
      readings.vix == null && readings.atr == null && readings.bbw == null && readings.retStdDev == null;
    if (errors.length === 0 && noneAvailable && cfg.enabled) {
      errors.push("Keine Indikator-Daten verfügbar (alle Quellen null/leer)");
    }
    s.lastError = errors.length > 0 ? errors.join(" | ") : null;

    if (s.lastError != null && cfg.enabled) {
      // Bewertung fehlgeschlagen → expliziter UNKNOWN-Zustand statt Fail-Open:
      // wirksames Limit auf dem konservativen Code-Boden; die Hysterese-
      // Maschine bleibt unangetastet (keine De-Eskalation auf Teil-/Fehldaten).
      const factor = adaptiveUnknownFactor(base);
      const reason = unknownReason("ERRORED", s.lastError);
      const effective = Math.max(base * factor, LIMIT_CEILINGS.maxRiskPerTrade[0]);
      applyAdaptiveRisk({ regime: "UNKNOWN", factor, reason, at, indicators });
      s.lastAssessment = assessment;
      s.lastUpdateAt = Date.now();

      const lastEvent = s.events[s.events.length - 1];
      const enteringUnknown = prevStatusRegime !== "UNKNOWN";
      const effectiveChanged = lastEvent == null || Math.abs(effective - lastEvent.effectiveMaxRiskPerTrade) > 1e-12;
      if (enteringUnknown || effectiveChanged) {
        const event: AdaptiveRiskEvent = {
          at,
          prevRegime: prevStatusRegime,
          regime: "UNKNOWN",
          factor,
          baseMaxRiskPerTrade: base,
          effectiveMaxRiskPerTrade: effective,
          triggered: assessment.triggered,
          reason,
        };
        s.events.push(event);
        if (s.events.length > EVENT_HISTORY_LENGTH) s.events.shift();
        s.lastChangeAt = at;
        console.warn(
          `[adaptive-risk] ${prevStatusRegime} → UNKNOWN: maxRiskPerTrade → ${(effective * 100).toFixed(2)} % (Code-Boden) — ${reason}`
        );
        await logAdaptiveEvent(event, "UNKNOWN");
        await persistActiveState(factor);
      }

      return buildStatus(s);
    }

    const prevRegime = s.machine.regime;
    const { regime } = s.machine.update(assessment.regime, cfg.deescalateAfter);
    const factor = regimeFactor(regime, cfg);
    // Wende den Faktor an und lies das wirksame (geklemmte) Limit zurück.
    const effective = applyAdaptiveRisk({
      regime,
      factor,
      reason: assessment.reason,
      at,
      indicators,
    }).maxRiskPerTrade;

    s.lastAssessment = assessment;
    s.lastUpdateAt = Date.now();

    const lastEvent = s.events[s.events.length - 1];
    const changed =
      regime !== prevRegime ||
      lastEvent == null ||
      Math.abs(effective - lastEvent.effectiveMaxRiskPerTrade) > 1e-12;
    if (changed) {
      const event: AdaptiveRiskEvent = {
        at,
        prevRegime,
        regime,
        factor,
        baseMaxRiskPerTrade: base,
        effectiveMaxRiskPerTrade: effective,
        triggered: assessment.triggered,
        reason: assessment.reason,
      };
      s.events.push(event);
      if (s.events.length > EVENT_HISTORY_LENGTH) s.events.shift();
      s.lastChangeAt = at;
      console.log(
        `[adaptive-risk] ${prevRegime} → ${regime}: maxRiskPerTrade ${(base * 100).toFixed(2)} % → ${(effective * 100).toFixed(2)} % — ${assessment.reason}`
      );
      await logAdaptiveEvent(event, regime);
      await persistActiveState(factor);
    }

    return buildStatus(s);
  })();

  s.updating = run;
  try {
    return await run;
  } catch (e) {
    // Sicherheitsnetz (H10/v1.36.21): Ein unerwarteter Fehler hält NICHT still
    // den letzten Zustand — der Zustand geht explizit auf UNKNOWN (fail-closed)
    // und das wirksame Limit auf den konservativen Code-Boden. So kann eine
    // schlafende Bewertung niemals wie „volles Risiko“ durchgehen.
    s.lastError = e instanceof Error ? e.message : String(e);
    if (s.config.enabled) {
      try {
        const base = getBaseLimits().maxRiskPerTrade;
        const factor = adaptiveUnknownFactor(base);
        applyAdaptiveRisk({
          regime: "UNKNOWN",
          factor,
          reason: unknownReason("ERRORED", s.lastError),
          at: new Date().toISOString(),
          indicators: {},
        });
      } catch {
        /* Risiko-Anwendung darf das Sicherheitsnetz nicht selbst brechen */
      }
    }
    return buildStatus(s);
  } finally {
    s.updating = null;
  }
}

/**
 * Billiger Aufrufspunkt für Turn-Pfade: bewertet nur, wenn die letzte
 * Bewertung älter als das Min-Interval ist (der Takt des Monitors hält sie
 * meist frisch). Single-Flight gegen parallele Turns.
 */
export function ensureAdaptiveRiskFresh(opts: UpdateOptions = {}): Promise<AdaptiveRiskStatus> {
  return updateAdaptiveRisk(opts);
}

/**
 * Synchroner Status-Snapshot für Agenten/Monitoring
 * (GET /api/firm/risk/volatility, GET /api/firm, Dashboard).
 * Liefert null, wenn noch nie eine Bewertung stattfand.
 */
export function getAdaptiveRiskStatus(): AdaptiveRiskStatus | null {
  const s = state();
  if (s.lastUpdateAt == null && s.lastAssessment == null) return null;
  return buildStatus(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test-Helfer
// ─────────────────────────────────────────────────────────────────────────────

/** Leert den kompletten Laufzeit-Zustand (nur für Tests). */
export function __resetAdaptiveRiskForTests(): void {
  delete G.__adaptiveRisk;
  vixCache = null;
}
