/**
 * Versionierte Signal-Decay-Exits (RMA-P5-05, v1.69.0).
 *
 * Reine, uhrfreie Entscheidungsschicht: kein DB-, Netzwerk- oder LLM-Zugriff.
 * Runtime (`src/lib/signalDecayRuntime.ts`) und Backtest
 * (`src/backtest/signalDecay.ts`) rufen dieselben Funktionen auf.
 *
 * ── Signalvertrag `sig1` / Semantik `mkt-sig-1` ─────────────────────────────
 * Normalisiertes, point-in-time Signal:
 *   direction        LONG | SHORT | FLAT | null
 *   strength         gemessene Stärke in [0, 1]; null = nicht verfügbar.
 *                    null wird NIE als 0 gelesen.
 *   confidence       Datenqualität in [0, 1]; beim Markt-Builder = Coverage.
 *                    Keine erfundene Modellwahrscheinlichkeit.
 *   calculatedAsOf   Berechnungszeit der Features (Close der letzten
 *                    verwendeten, bereits geschlossenen Kerze), ISO-8601.
 *   availableAt      Verfügbarkeitszeit. Entscheidungen mit availableAt > asOf
 *                    sind Look-ahead und werden verworfen (FUTURE).
 *   computedAt       Aufbauzeit dieses Snapshot-Objekts.
 *   coverage         Anteil vorhandener Pflicht-Features in [0, 1]; null =
 *                    unbekannt (nicht 0).
 *   feature/model/config version
 *                    Versionsstempel der Formel. Abweichung ohne explizite,
 *                    registrierte Migration ⇒ INCOMPATIBLE, kein Exit.
 *
 * Zeitsemantik (drei Achsen, nie vermischt):
 *   calculatedAsOf ≤ availableAt ≤ asOf (Entscheidungszeit)
 *   computedAt ≥ availableAt
 * Unvollständige Kerzen (Open-Zeit + Dauer > asOf bei timeBasis "open") gehen
 * nicht in die Formel ein.
 *
 * ── Formel `mkt-sig-1` (Einheiten) ──────────────────────────────────────────
 * Pflicht-Features (Coverage-Nenner = 4): Close > 0, EMA9, EMA21, RSI14.
 * Warmup: mindestens 21 Closes, sonst kein Richtungssignal (Stärke bleibt
 * null — der RSI-Neutralwert 50 der Indikator-Hilfe wird NICHT verwendet).
 *
 *   emaSpread   = (EMA9 − EMA21) / Close          (dimensionslos)
 *   spreadScore = clamp(emaSpread / 0.02, −1, 1)  (2 % Spread = volle Einheit)
 *   rsiScore    = clamp((RSI14 − 50) / 50, −1, 1)
 *   composite   = 0.6 · spreadScore + 0.4 · rsiScore
 *   direction   = LONG wenn composite > 0.05, SHORT wenn < −0.05, sonst FLAT
 *   strength    = |composite| gerundet auf 6 Nachkommastellen, in [0, 1]
 *   confidence  = coverage (Datenqualität, nicht eine Trefferwahrscheinlichkeit)
 *
 * ── Decay-Policy `sdp1` (pro Strategieklasse, Default aus) ──────────────────
 * Ein Exit-Kandidat entsteht nur bei KOMPATIBLEM aktuellem Signal und nur
 * wenn die Klasse `enabled` ist. Schwellen (alle geklemmt):
 *   absolut   entry.strength − current.strength ≥ absoluteDrop
 *   relativ   (entry − current) / entry ≥ relativeDrop, nur wenn entry > 0
 *   Halbwertszeit (optional, halfLifeMs ≠ null):
 *             Haltedauer ≥ halfLifeMs UND
 *             current.strength ≤ entry.strength · halfLifeRemainingRatio
 *             (Default-Ratio 0.5 = beobachtete Stärke höchstens die Hälfte
 *             der Entry-Stärke nach einer Halbwertszeit). Ein stabiles Signal
 *             (current ≈ entry) löst den Halbwertszeit-Pfad NIE aus.
 *   Reversal  aktuelle Richtung entgegengesetzt zur POSITIONS-Seite (nicht
 *             nur zur Entry-Richtung), Stärke ≥ reversalMinStrength und
 *             Confidence ≥ reversalMinConfidence.
 * thresholdMode steuert nur absolut/relativ (`absolute|relative|either|both`).
 * Halbwertszeit und Reversal sind zusätzliche, unabhängig schaltbare Pfade
 * (ODER). Mindesthaltedauer: Kandidaten davor zählen nicht als Bestätigung
 * und setzen die Zählung nicht zurück.
 *
 * Hysterese: `confirmationCount` aufeinanderfolgende KOMPATIBLE Breach-
 * Beobachtungen. Eine kompatible Nicht-Breach setzt die Zählung auf 0.
 * Missing/stale/incompatible/invalid/future friert die Zählung ein (weder
 * Exit noch Reset). Dieselbe Observation-Key (idempotent) zählt nicht doppelt
 * und löst keinen nachträglichen Exit aus — Aktivierung replayt keine
 * historischen Would-Exits.
 *
 * ── Priorität (Safety bleibt vorrangig) ─────────────────────────────────────
 * Kill-Switch / Flatten liegen AUSSERHALB dieser Funktion und schließen über
 * ihren eigenen Pfad. Ein bewaffneter Kill-Switch unterdrückt SIGNAL_DECAY
 * (kein zweiter Close-Pfad). Innerhalb von `decideExit`:
 *   STOP_LOSS → TAKE_PROFIT → TRAILING_STOP → TIME_STOP → SIGNAL_DECAY.
 * SIGNAL_DECAY ist von TIME_STOP und von Freitext-Gründen (MANUAL_FLATTEN,
 * AGENT_CLOSE, …) ein eigener Enum-Wert.
 *
 * ── Fail-closed ─────────────────────────────────────────────────────────────
 * Fehlende, stale, inkompatible, invalide oder zukünftige Signale erzwingen
 * KEINEN Signal-Exit. `null` bleibt `null`.
 */

import { fingerprint } from "../attribution/hashes";
import { ema, rsi } from "./indicators";
import type { StrategyClass } from "./marketRegime";

export const SIGNAL_CONTRACT_VERSION = "sig1" as const;
export const SIGNAL_SEMANTICS_VERSION = "mkt-sig-1";
export const SIGNAL_FEATURE_VERSION = "ohlcv-rsi-ema-1";
export const SIGNAL_MODEL_VERSION = "deterministic-linear-1";
export const SIGNAL_CONFIG_VERSION = "mkt-sig-cfg-1";

/** Frühere Semantik, nur über die explizite Migration `mig-mkt-sig-0-to-1` lesbar. */
export const SIGNAL_SEMANTICS_VERSION_V0 = "mkt-sig-0";
/** Prozent-Skala (0–100), nur über `mig-strength-pct-to-unit` lesbar. */
export const SIGNAL_SEMANTICS_PCT = "mkt-sig-pct";

export const SIGNAL_DECAY_POLICY_PREFIX = "sdp1";

export type SignalDirection = "LONG" | "SHORT" | "FLAT";
export type StrategyClassKey = StrategyClass | "unclassified";
export type SignalDecayMode = "off" | "monitor" | "active";
export type ThresholdMode = "absolute" | "relative" | "either" | "both";
export type CandleTimeBasis = "open" | "close";

export const STRATEGY_CLASS_KEYS: readonly StrategyClassKey[] = [
  "mean-reversion",
  "trend",
  "breakout",
  "unclassified",
];

export type SignalSnapshot = {
  contractVersion: typeof SIGNAL_CONTRACT_VERSION;
  semanticsVersion: string;
  featureVersion: string;
  modelVersion: string;
  configVersion: string;
  direction: SignalDirection | null;
  /** [0, 1] wenn gemessen. null = nicht verfügbar — nie still 0. */
  strength: number | null;
  /** [0, 1] wenn gemessen. null = nicht verfügbar. */
  confidence: number | null;
  /** ISO-8601 oder null, wenn keine Feature-Zeit belegbar ist. */
  calculatedAsOf: string | null;
  /** ISO-8601 oder null. */
  availableAt: string | null;
  /** ISO-8601. */
  computedAt: string;
  /** [0, 1] oder null (unbekannt ≠ 0). */
  coverage: number | null;
  strategyClass: StrategyClassKey;
  /** Gesetzte Migrations-ID, wenn dieser Snapshot das Ergebnis einer Migration ist. */
  migrationId: string | null;
};

export type SignalCompatibilityStatus =
  | "COMPATIBLE"
  | "MISSING"
  | "STALE"
  | "INCOMPATIBLE"
  | "INVALID"
  | "FUTURE"
  | "LOW_COVERAGE";

export type SignalDecayReasonCode =
  | "MODE_OFF"
  | "DISABLED"
  | "MISSING_ENTRY"
  | "MISSING_CURRENT"
  | "STALE"
  | "INCOMPATIBLE"
  | "INVALID"
  | "FUTURE"
  | "LOW_COVERAGE"
  | "MIN_HOLD"
  | "HOLD"
  | "ABSOLUTE_DROP"
  | "RELATIVE_DROP"
  | "HALF_LIFE"
  | "REVERSAL"
  | "CONFIRMING"
  | "DUPLICATE_OBSERVATION"
  | "SUPPRESSED_KILL_SWITCH"
  | "WOULD_EXIT"
  | "EXIT";

export const SIGNAL_DECAY_REASON_CODES: readonly SignalDecayReasonCode[] = [
  "MODE_OFF",
  "DISABLED",
  "MISSING_ENTRY",
  "MISSING_CURRENT",
  "STALE",
  "INCOMPATIBLE",
  "INVALID",
  "FUTURE",
  "LOW_COVERAGE",
  "MIN_HOLD",
  "HOLD",
  "ABSOLUTE_DROP",
  "RELATIVE_DROP",
  "HALF_LIFE",
  "REVERSAL",
  "CONFIRMING",
  "DUPLICATE_OBSERVATION",
  "SUPPRESSED_KILL_SWITCH",
  "WOULD_EXIT",
  "EXIT",
];

/**
 * Dokumentierte Priorität. `KILL_SWITCH` ist kein `ExitReason` — der
 * Notfall-Flatten besitzt den Close und unterdrückt SIGNAL_DECAY.
 */
export const EXIT_PRIORITY = [
  "KILL_SWITCH",
  "STOP_LOSS",
  "TAKE_PROFIT",
  "TRAILING_STOP",
  "TIME_STOP",
  "SIGNAL_DECAY",
] as const;

export type ClassDecayPolicy = {
  /** Default false — auch im Modus `active` bleibt die Klasse aus, bis sie explizit an ist. */
  enabled: boolean;
  /** Absoluter Stärkerückgang in Stärkepunkten [0, 1]. Bounds [0.05, 0.95]. */
  absoluteDrop: number;
  /** Relativer Rückgang als Anteil der Entry-Stärke. Bounds [0.05, 0.95]. */
  relativeDrop: number;
  thresholdMode: ThresholdMode;
  reversalEnabled: boolean;
  /** Bounds (0, 1]. */
  reversalMinStrength: number;
  /** Bounds [0, 1]. */
  reversalMinConfidence: number;
  /** Mindesthaltedauer in ms, bevor ein Kandidat zählt. Bounds [0, 30d]. */
  minHoldMs: number;
  /** Aufeinanderfolgende kompatible Breaches. Bounds [1, 20]. */
  confirmationCount: number;
  /** null = Halbwertszeit-Pfad aus. Sonst Bounds [60s, 30d]. */
  halfLifeMs: number | null;
  /** Anteil der Entry-Stärke, bei/unter dem der Halbwertszeit-Pfad zählt. Bounds [0.05, 0.95]. */
  halfLifeRemainingRatio: number;
  /** Maximales Alter availableAt → asOf. Bounds [60s, 7d]. */
  maxStalenessMs: number;
  /** Mindest-Coverage für Kompatibilität. Bounds [0, 1]. */
  minCoverage: number;
};

export type SignalDecayConfig = {
  mode: SignalDecayMode;
  /** Explizit akzeptierte Migrations-IDs. Default leer = strikter Versionsgleichstand. */
  acceptedMigrations: readonly string[];
  classes: Record<StrategyClassKey, ClassDecayPolicy>;
};

export type SignalDecayInput = {
  entry: SignalSnapshot | null;
  current: SignalSnapshot | null;
  openedAtMs: number;
  asOfMs: number;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  markPrice: number;
  strategyClass: StrategyClassKey;
  confirmation: {
    streak: number;
    lastObservationKey: string | null;
    policyVersion: string | null;
  };
  mode: SignalDecayMode;
  config: SignalDecayConfig;
  killSwitchArmed: boolean;
};

export type SignalDecayEvaluation = {
  status: SignalCompatibilityStatus | "DISABLED" | "OFF";
  reasonCode: SignalDecayReasonCode;
  /** Menschenlesbare, deterministische Begründung (keine Secrets, kein Freitext von außen). */
  reason: string;
  policyVersion: string;
  strategyClass: StrategyClassKey;
  breach: boolean;
  breachKind: "ABSOLUTE_DROP" | "RELATIVE_DROP" | "HALF_LIFE" | "REVERSAL" | null;
  shouldExit: boolean;
  wouldExit: boolean;
  /** true nur beim Übergang streak < N → streak ≥ N auf einer neuen Beobachtung. */
  newlyConfirmed: boolean;
  streak: number;
  streakChanged: boolean;
  observationKey: string | null;
  duplicate: boolean;
  coverage: number | null;
  entryStrength: number | null;
  currentStrength: number | null;
  entryConfidence: number | null;
  currentConfidence: number | null;
  migrationId: string | null;
  /** Mark-to-market, wenn jetzt zum markPrice geschlossen würde. null = nicht belegbar (nie still 0). */
  counterfactualPnl: number | null;
  /** Audit-Payload ohne zukünftige Zeitstempel. null, wenn nichts protokolliert werden soll. */
  audit: SignalDecayAudit | null;
};

export type SignalDecayAudit = {
  policyVersion: string;
  policyReason: SignalDecayReasonCode;
  strategyClass: StrategyClassKey;
  coverage: number | null;
  semanticsVersion: string | null;
  featureVersion: string | null;
  modelVersion: string | null;
  configVersion: string | null;
  migrationId: string | null;
  entryDirection: SignalDirection | null;
  entryStrength: number | null;
  entryConfidence: number | null;
  currentDirection: SignalDirection | null;
  currentStrength: number | null;
  currentConfidence: number | null;
  entryCalculatedAsOf: string | null;
  entryAvailableAt: string | null;
  currentCalculatedAsOf: string | null;
  currentAvailableAt: string | null;
  asOf: string;
  computedAt: string;
  confirmStreak: number;
  confirmationRequired: number;
  counterfactualPnl: number | null;
  mode: SignalDecayMode;
};

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export const SIGNAL_DECAY_BOUNDS = {
  absoluteDrop: [0.05, 0.95] as const,
  relativeDrop: [0.05, 0.95] as const,
  reversalMinStrength: [0.05, 1] as const,
  reversalMinConfidence: [0, 1] as const,
  minHoldMs: [0, 30 * DAY_MS] as const,
  confirmationCount: [1, 20] as const,
  halfLifeMs: [MIN_MS, 30 * DAY_MS] as const,
  halfLifeRemainingRatio: [0.05, 0.95] as const,
  maxStalenessMs: [MIN_MS, 7 * DAY_MS] as const,
  minCoverage: [0, 1] as const,
};

/** Flat-Band und Spread-Norm der Semantik `mkt-sig-1` (Teil des Config-Stempels). */
export const MARKET_SIGNAL_PARAMS = {
  flatBand: 0.05,
  spreadFullScale: 0.02,
  spreadWeight: 0.6,
  rsiWeight: 0.4,
  minCloses: 21,
} as const;

const DEFAULT_CLASS: ClassDecayPolicy = {
  enabled: false,
  absoluteDrop: 0.3,
  relativeDrop: 0.4,
  thresholdMode: "either",
  reversalEnabled: true,
  reversalMinStrength: 0.35,
  reversalMinConfidence: 0.6,
  minHoldMs: 15 * MIN_MS,
  confirmationCount: 3,
  halfLifeMs: null,
  halfLifeRemainingRatio: 0.5,
  maxStalenessMs: 30 * MIN_MS,
  minCoverage: 0.75,
};

/**
 * Klassen-Defaults sind bounded und **aus**. Die Schwellen gelten erst, wenn
 * die Klasse explizit aktiviert wird — sie ändern Paper-/Backtest-Defaults nicht.
 */
export const DEFAULT_CLASS_POLICIES: Record<StrategyClassKey, ClassDecayPolicy> = {
  "mean-reversion": {
    ...DEFAULT_CLASS,
    absoluteDrop: 0.25,
    relativeDrop: 0.4,
    minHoldMs: 15 * MIN_MS,
    confirmationCount: 3,
    halfLifeMs: 4 * 3_600_000,
    maxStalenessMs: 30 * MIN_MS,
  },
  trend: {
    ...DEFAULT_CLASS,
    absoluteDrop: 0.3,
    relativeDrop: 0.45,
    minHoldMs: 60 * MIN_MS,
    confirmationCount: 3,
    halfLifeMs: 24 * 3_600_000,
    maxStalenessMs: 2 * 3_600_000,
  },
  breakout: {
    ...DEFAULT_CLASS,
    absoluteDrop: 0.35,
    relativeDrop: 0.5,
    minHoldMs: 30 * MIN_MS,
    confirmationCount: 2,
    halfLifeMs: 8 * 3_600_000,
    maxStalenessMs: 60 * MIN_MS,
  },
  unclassified: {
    ...DEFAULT_CLASS,
    enabled: false,
    halfLifeMs: null,
    maxStalenessMs: 30 * MIN_MS,
  },
};

export const DEFAULT_SIGNAL_DECAY_CONFIG: SignalDecayConfig = {
  mode: "monitor",
  acceptedMigrations: [],
  classes: DEFAULT_CLASS_POLICIES,
};

export type CandleLike = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

// ── Hilfen ──────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(Math.trunc(value), min, max);
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

export function isStrategyClassKey(value: unknown): value is StrategyClassKey {
  return value === "mean-reversion" || value === "trend" || value === "breakout" || value === "unclassified";
}

export function classKey(value: unknown): StrategyClassKey {
  return isStrategyClassKey(value) ? value : "unclassified";
}

export function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  switch (String(value).trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function parseMode(value: string | undefined, fallback: SignalDecayMode): SignalDecayMode {
  if (value === undefined) return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === "off" || v === "monitor" || v === "active") return v;
  return fallback;
}

function parseThresholdMode(value: string | undefined, fallback: ThresholdMode): ThresholdMode {
  if (value === undefined) return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === "absolute" || v === "relative" || v === "either" || v === "both") return v;
  return fallback;
}

export function signalHash(snapshot: SignalSnapshot): string {
  return fingerprint("sig1", snapshot);
}

export function observationKeyOf(snapshot: SignalSnapshot): string | null {
  if (snapshot.availableAt == null || snapshot.strength == null || snapshot.direction == null) return null;
  return fingerprint("sdo1", {
    availableAt: snapshot.availableAt,
    semanticsVersion: snapshot.semanticsVersion,
    featureVersion: snapshot.featureVersion,
    modelVersion: snapshot.modelVersion,
    configVersion: snapshot.configVersion,
    direction: snapshot.direction,
    strength: snapshot.strength,
    confidence: snapshot.confidence,
    migrationId: snapshot.migrationId,
  });
}

export function signalDecayEventId(positionId: string, observationKey: string, policyVersion: string): string {
  return fingerprint("sde1", { positionId, observationKey, policyVersion });
}

/**
 * Mark-to-market in Kontowährung (ohne erfundene Gebühren).
 * Ungültige Eingaben → null, nicht 0. Preis = Entry ist ein echtes 0.
 */
export function markToMarketPnl(
  side: "LONG" | "SHORT",
  qty: number,
  entryPrice: number,
  markPrice: number,
): number | null {
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!Number.isFinite(markPrice) || markPrice <= 0) return null;
  const gross = side === "LONG" ? qty * (markPrice - entryPrice) : qty * (entryPrice - markPrice);
  return Number.isFinite(gross) ? round6(gross) : null;
}

// ── Policy ──────────────────────────────────────────────────────────────────

function clampClassPolicy(raw: Partial<ClassDecayPolicy> | undefined, fallback: ClassDecayPolicy): ClassDecayPolicy {
  const src = raw ?? {};
  const halfRaw = src.halfLifeMs;
  let halfLifeMs: number | null = fallback.halfLifeMs;
  if (halfRaw === null) halfLifeMs = null;
  else if (typeof halfRaw === "number") {
    if (!Number.isFinite(halfRaw) || halfRaw <= 0) halfLifeMs = null;
    else {
      halfLifeMs = clamp(halfRaw, SIGNAL_DECAY_BOUNDS.halfLifeMs[0], SIGNAL_DECAY_BOUNDS.halfLifeMs[1]);
    }
  }
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : fallback.enabled,
    absoluteDrop: clampFinite(
      src.absoluteDrop ?? fallback.absoluteDrop,
      SIGNAL_DECAY_BOUNDS.absoluteDrop[0],
      SIGNAL_DECAY_BOUNDS.absoluteDrop[1],
      fallback.absoluteDrop,
    ),
    relativeDrop: clampFinite(
      src.relativeDrop ?? fallback.relativeDrop,
      SIGNAL_DECAY_BOUNDS.relativeDrop[0],
      SIGNAL_DECAY_BOUNDS.relativeDrop[1],
      fallback.relativeDrop,
    ),
    thresholdMode: parseThresholdMode(
      typeof src.thresholdMode === "string" ? src.thresholdMode : undefined,
      fallback.thresholdMode,
    ),
    reversalEnabled: typeof src.reversalEnabled === "boolean" ? src.reversalEnabled : fallback.reversalEnabled,
    reversalMinStrength: clampFinite(
      src.reversalMinStrength ?? fallback.reversalMinStrength,
      SIGNAL_DECAY_BOUNDS.reversalMinStrength[0],
      SIGNAL_DECAY_BOUNDS.reversalMinStrength[1],
      fallback.reversalMinStrength,
    ),
    reversalMinConfidence: clampFinite(
      src.reversalMinConfidence ?? fallback.reversalMinConfidence,
      SIGNAL_DECAY_BOUNDS.reversalMinConfidence[0],
      SIGNAL_DECAY_BOUNDS.reversalMinConfidence[1],
      fallback.reversalMinConfidence,
    ),
    minHoldMs: clampFinite(
      src.minHoldMs ?? fallback.minHoldMs,
      SIGNAL_DECAY_BOUNDS.minHoldMs[0],
      SIGNAL_DECAY_BOUNDS.minHoldMs[1],
      fallback.minHoldMs,
    ),
    confirmationCount: clampInt(
      src.confirmationCount ?? fallback.confirmationCount,
      SIGNAL_DECAY_BOUNDS.confirmationCount[0],
      SIGNAL_DECAY_BOUNDS.confirmationCount[1],
      fallback.confirmationCount,
    ),
    halfLifeMs,
    halfLifeRemainingRatio: clampFinite(
      src.halfLifeRemainingRatio ?? fallback.halfLifeRemainingRatio,
      SIGNAL_DECAY_BOUNDS.halfLifeRemainingRatio[0],
      SIGNAL_DECAY_BOUNDS.halfLifeRemainingRatio[1],
      fallback.halfLifeRemainingRatio,
    ),
    maxStalenessMs: clampFinite(
      src.maxStalenessMs ?? fallback.maxStalenessMs,
      SIGNAL_DECAY_BOUNDS.maxStalenessMs[0],
      SIGNAL_DECAY_BOUNDS.maxStalenessMs[1],
      fallback.maxStalenessMs,
    ),
    minCoverage: clampFinite(
      src.minCoverage ?? fallback.minCoverage,
      SIGNAL_DECAY_BOUNDS.minCoverage[0],
      SIGNAL_DECAY_BOUNDS.minCoverage[1],
      fallback.minCoverage,
    ),
  };
}

export function resolveSignalDecayConfig(
  overrides: {
    mode?: SignalDecayMode;
    acceptedMigrations?: readonly string[];
    classes?: Partial<Record<StrategyClassKey, Partial<ClassDecayPolicy>>>;
  } = {},
): SignalDecayConfig {
  const classes = {} as Record<StrategyClassKey, ClassDecayPolicy>;
  for (const key of STRATEGY_CLASS_KEYS) {
    classes[key] = clampClassPolicy(overrides.classes?.[key], DEFAULT_CLASS_POLICIES[key]);
  }
  return {
    mode: overrides.mode ?? DEFAULT_SIGNAL_DECAY_CONFIG.mode,
    acceptedMigrations: [...(overrides.acceptedMigrations ?? [])],
    classes,
  };
}

/**
 * Lädt die Policy aus der Umgebung. Unbekannter Modus ⇒ `monitor` (messen,
 * nicht live schließen). Klassen bleiben aus, solange ihr Flag nicht explizit
 * true ist. Schwellen werden auf die Bounds geklemmt.
 *
 * Env:
 *   SIGNAL_DECAY_MODE                         off | monitor | active
 *   SIGNAL_DECAY_MIGRATIONS                   kommaseparierte Migrations-IDs
 *   SIGNAL_DECAY_CLASS_TREND                  true/false
 *   SIGNAL_DECAY_CLASS_MEAN_REVERSION         true/false
 *   SIGNAL_DECAY_CLASS_BREAKOUT               true/false
 *   SIGNAL_DECAY_CLASS_UNCLASSIFIED           true/false
 *   SIGNAL_DECAY_THRESHOLD_MODE               globaler Override, sonst Klassen-Default
 */
export function loadSignalDecayConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  overrides: Parameters<typeof resolveSignalDecayConfig>[0] = {},
): SignalDecayConfig {
  const migrations = String(env.SIGNAL_DECAY_MIGRATIONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && KNOWN_MIGRATIONS.has(s));
  const threshold = env.SIGNAL_DECAY_THRESHOLD_MODE;
  const classEnabled: Record<StrategyClassKey, boolean> = {
    trend: parseBoolean(env.SIGNAL_DECAY_CLASS_TREND, false),
    "mean-reversion": parseBoolean(env.SIGNAL_DECAY_CLASS_MEAN_REVERSION, false),
    breakout: parseBoolean(env.SIGNAL_DECAY_CLASS_BREAKOUT, false),
    unclassified: parseBoolean(env.SIGNAL_DECAY_CLASS_UNCLASSIFIED, false),
  };
  const classes: Partial<Record<StrategyClassKey, Partial<ClassDecayPolicy>>> = {};
  for (const key of STRATEGY_CLASS_KEYS) {
    classes[key] = {
      enabled: classEnabled[key],
      ...(threshold !== undefined ? { thresholdMode: parseThresholdMode(threshold, DEFAULT_CLASS_POLICIES[key].thresholdMode) } : {}),
      ...overrides.classes?.[key],
    };
  }
  return resolveSignalDecayConfig({
    mode: parseMode(env.SIGNAL_DECAY_MODE, "monitor"),
    acceptedMigrations: overrides.acceptedMigrations ?? migrations,
    classes,
  });
}

export function policyVersionOf(config: SignalDecayConfig): string {
  return fingerprint(SIGNAL_DECAY_POLICY_PREFIX, {
    contract: SIGNAL_CONTRACT_VERSION,
    semantics: SIGNAL_SEMANTICS_VERSION,
    feature: SIGNAL_FEATURE_VERSION,
    model: SIGNAL_MODEL_VERSION,
    config: SIGNAL_CONFIG_VERSION,
    mode: config.mode,
    acceptedMigrations: [...config.acceptedMigrations].sort(),
    classes: config.classes,
  });
}

export function anyClassEnabled(config: SignalDecayConfig): boolean {
  return STRATEGY_CLASS_KEYS.some((k) => config.classes[k].enabled);
}

// ── Migrationen (explizit, nie still) ───────────────────────────────────────

export type MigrationResult =
  | { ok: true; snapshot: SignalSnapshot }
  | { ok: false; reason: string };

type Migration = {
  id: string;
  fromSemantics: string;
  toSemantics: string;
  apply: (snapshot: SignalSnapshot) => MigrationResult;
};

function aliasMigration(id: string, fromSemantics: string, toSemantics: string): Migration {
  return {
    id,
    fromSemantics,
    toSemantics,
    apply(snapshot) {
      if (snapshot.semanticsVersion !== fromSemantics) {
        return { ok: false, reason: "SEMANTICS_MISMATCH" };
      }
      return {
        ok: true,
        snapshot: { ...snapshot, semanticsVersion: toSemantics, migrationId: id },
      };
    },
  };
}

/**
 * Prozent → Einheit. Stärke muss eindeutig Prozent sein (> 1 und ≤ 100).
 * Werte in (0, 1] sind mehrdeutig und werden abgelehnt (fail-closed), nicht
 * still durch 100 geteilt. Confidence > 1 wird ebenfalls /100 skaliert;
 * Confidence in [0, 1] bleibt (bereits Einheit).
 */
function pctToUnit(snapshot: SignalSnapshot): MigrationResult {
  if (snapshot.semanticsVersion !== SIGNAL_SEMANTICS_PCT) {
    return { ok: false, reason: "SEMANTICS_MISMATCH" };
  }
  const strength = snapshot.strength;
  const confidence = snapshot.confidence;
  if (strength == null || confidence == null) return { ok: false, reason: "MISSING_SCALE" };
  if (!(strength > 1 && strength <= 100)) return { ok: false, reason: "AMBIGUOUS_SCALE" };
  const nextConfidence = confidence > 1 ? confidence / 100 : confidence;
  if (!(nextConfidence >= 0 && nextConfidence <= 1)) return { ok: false, reason: "CONFIDENCE_OUT_OF_RANGE" };
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      semanticsVersion: SIGNAL_SEMANTICS_VERSION,
      strength: round6(strength / 100),
      confidence: round6(nextConfidence),
      migrationId: "mig-strength-pct-to-unit",
    },
  };
}

const MIGRATIONS: readonly Migration[] = [
  aliasMigration("mig-mkt-sig-0-to-1", SIGNAL_SEMANTICS_VERSION_V0, SIGNAL_SEMANTICS_VERSION),
  {
    id: "mig-strength-pct-to-unit",
    fromSemantics: SIGNAL_SEMANTICS_PCT,
    toSemantics: SIGNAL_SEMANTICS_VERSION,
    apply: pctToUnit,
  },
];

const KNOWN_MIGRATIONS = new Set(MIGRATIONS.map((m) => m.id));

export function knownMigrationIds(): readonly string[] {
  return MIGRATIONS.map((m) => m.id);
}

export function applySignalMigration(snapshot: SignalSnapshot, migrationId: string): MigrationResult {
  const migration = MIGRATIONS.find((m) => m.id === migrationId);
  if (!migration) return { ok: false, reason: "UNKNOWN_MIGRATION" };
  return migration.apply(snapshot);
}

// ── Validierung / Kompatibilität ────────────────────────────────────────────

export function validateSignalSnapshot(value: unknown): { ok: true; snapshot: SignalSnapshot } | { ok: false; reason: string } {
  if (value == null || typeof value !== "object") return { ok: false, reason: "NOT_AN_OBJECT" };
  const v = value as Partial<SignalSnapshot>;
  if (v.contractVersion !== SIGNAL_CONTRACT_VERSION) return { ok: false, reason: "CONTRACT" };
  if (typeof v.semanticsVersion !== "string" || v.semanticsVersion.length === 0 || v.semanticsVersion.length > 64) {
    return { ok: false, reason: "SEMANTICS" };
  }
  if (typeof v.featureVersion !== "string" || typeof v.modelVersion !== "string" || typeof v.configVersion !== "string") {
    return { ok: false, reason: "VERSION" };
  }
  if (v.direction != null && v.direction !== "LONG" && v.direction !== "SHORT" && v.direction !== "FLAT") {
    return { ok: false, reason: "DIRECTION" };
  }
  if (v.strength != null && (typeof v.strength !== "number" || !Number.isFinite(v.strength) || v.strength < 0 || v.strength > 1)) {
    return { ok: false, reason: "STRENGTH" };
  }
  if (v.confidence != null && (typeof v.confidence !== "number" || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1)) {
    return { ok: false, reason: "CONFIDENCE" };
  }
  if (v.coverage != null && (typeof v.coverage !== "number" || !Number.isFinite(v.coverage) || v.coverage < 0 || v.coverage > 1)) {
    return { ok: false, reason: "COVERAGE" };
  }
  if (typeof v.computedAt !== "string" || parseIsoMs(v.computedAt) == null) return { ok: false, reason: "COMPUTED_AT" };
  if (v.calculatedAsOf != null && parseIsoMs(v.calculatedAsOf) == null) return { ok: false, reason: "CALCULATED_AS_OF" };
  if (v.availableAt != null && parseIsoMs(v.availableAt) == null) return { ok: false, reason: "AVAILABLE_AT" };
  if (!isStrategyClassKey(v.strategyClass)) return { ok: false, reason: "CLASS" };
  if (v.migrationId != null && (typeof v.migrationId !== "string" || v.migrationId.length > 64)) {
    return { ok: false, reason: "MIGRATION" };
  }
  const calculated = parseIsoMs(v.calculatedAsOf ?? null);
  const available = parseIsoMs(v.availableAt ?? null);
  const computed = parseIsoMs(v.computedAt) as number;
  if (calculated != null && available != null && calculated > available) return { ok: false, reason: "TIME_ORDER" };
  if (available != null && computed < available) return { ok: false, reason: "TIME_ORDER" };
  return {
    ok: true,
    snapshot: {
      contractVersion: SIGNAL_CONTRACT_VERSION,
      semanticsVersion: v.semanticsVersion,
      featureVersion: v.featureVersion,
      modelVersion: v.modelVersion,
      configVersion: v.configVersion,
      direction: v.direction ?? null,
      strength: v.strength ?? null,
      confidence: v.confidence ?? null,
      calculatedAsOf: v.calculatedAsOf ?? null,
      availableAt: v.availableAt ?? null,
      computedAt: v.computedAt,
      coverage: v.coverage ?? null,
      strategyClass: v.strategyClass,
      migrationId: v.migrationId ?? null,
    },
  };
}

export type CompatibilityAssessment = {
  status: SignalCompatibilityStatus;
  reason: string;
  /** Entry nach angewendeter Migration (Kopie). null, wenn nicht kompatibel. */
  entry: SignalSnapshot | null;
  current: SignalSnapshot | null;
  migrationId: string | null;
};

function versionsCompatible(entry: SignalSnapshot, current: SignalSnapshot): boolean {
  return (
    entry.contractVersion === current.contractVersion &&
    entry.semanticsVersion === current.semanticsVersion &&
    entry.featureVersion === current.featureVersion &&
    entry.modelVersion === current.modelVersion &&
    entry.configVersion === current.configVersion
  );
}

/**
 * Prüft, ob Entry und Current dieselbe Semantik tragen oder eine explizit
 * akzeptierte Migration den Entry auf die Current-Semantik hebt.
 * Zukünftige availableAt/calculatedAsOf relativ zu asOf ⇒ FUTURE (kein Exit).
 */
export function assessCompatibility(
  entryRaw: SignalSnapshot | null,
  currentRaw: SignalSnapshot | null,
  asOfMs: number,
  policy: ClassDecayPolicy,
  acceptedMigrations: readonly string[],
): CompatibilityAssessment {
  if (entryRaw == null) return { status: "MISSING", reason: "MISSING_ENTRY", entry: null, current: null, migrationId: null };
  if (currentRaw == null) return { status: "MISSING", reason: "MISSING_CURRENT", entry: null, current: null, migrationId: null };
  const entryValid = validateSignalSnapshot(entryRaw);
  const currentValid = validateSignalSnapshot(currentRaw);
  if (!entryValid.ok) return { status: "INVALID", reason: `ENTRY_${entryValid.reason}`, entry: null, current: null, migrationId: null };
  if (!currentValid.ok) return { status: "INVALID", reason: `CURRENT_${currentValid.reason}`, entry: null, current: null, migrationId: null };
  let entry = entryValid.snapshot;
  const current = currentValid.snapshot;

  let migrationId: string | null = null;
  if (!versionsCompatible(entry, current)) {
    const requested = current.migrationId;
    const candidates = [
      ...(requested ? [requested] : []),
      ...acceptedMigrations.filter((id) => id !== requested),
    ];
    let migrated = false;
    for (const id of candidates) {
      if (!KNOWN_MIGRATIONS.has(id)) continue;
      if (requested == null && !acceptedMigrations.includes(id)) continue;
      if (requested != null && id !== requested && !acceptedMigrations.includes(id)) continue;
      const spec = MIGRATIONS.find((m) => m.id === id);
      if (!spec) continue;
      if (spec.fromSemantics !== entry.semanticsVersion || spec.toSemantics !== current.semanticsVersion) continue;
      const applied = spec.apply(entry);
      if (!applied.ok) {
        return { status: "INCOMPATIBLE", reason: applied.reason, entry: null, current, migrationId: null };
      }
      entry = applied.snapshot;
      if (!versionsCompatible(entry, current)) continue;
      migrationId = id;
      migrated = true;
      break;
    }
    if (!migrated) {
      return {
        status: "INCOMPATIBLE",
        reason: "VERSION_MISMATCH",
        entry: null,
        current,
        migrationId: null,
      };
    }
  }

  if (entry.strength == null || entry.direction == null || entry.confidence == null) {
    return { status: "MISSING", reason: "ENTRY_INCOMPLETE", entry: null, current, migrationId };
  }
  if (current.strength == null || current.direction == null || current.confidence == null) {
    return { status: "MISSING", reason: "CURRENT_INCOMPLETE", entry, current, migrationId };
  }
  if (current.coverage == null || current.coverage < policy.minCoverage) {
    return { status: "LOW_COVERAGE", reason: "COVERAGE", entry, current, migrationId };
  }
  const available = parseIsoMs(current.availableAt);
  const calculated = parseIsoMs(current.calculatedAsOf);
  if (available == null || calculated == null) {
    return { status: "INVALID", reason: "CURRENT_TIME_MISSING", entry, current, migrationId };
  }
  if (available > asOfMs || calculated > asOfMs) {
    return { status: "FUTURE", reason: "LOOKAHEAD", entry, current, migrationId };
  }
  const entryAvailable = parseIsoMs(entry.availableAt);
  if (entryAvailable != null && entryAvailable > asOfMs) {
    return { status: "FUTURE", reason: "ENTRY_LOOKAHEAD", entry, current, migrationId };
  }
  if (asOfMs - available > policy.maxStalenessMs) {
    return { status: "STALE", reason: "STALE", entry, current, migrationId };
  }
  return { status: "COMPATIBLE", reason: "COMPATIBLE", entry, current, migrationId };
}

// ── Markt-Signal ────────────────────────────────────────────────────────────

function rsiOrNull(closes: number[]): number | null {
  if (closes.length < 15) return null;
  const value = rsi(closes, 14);
  return Number.isFinite(value) ? value : null;
}

function emaLastOrNull(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const series = ema(closes, period);
  const last = series[series.length - 1];
  return Number.isFinite(last) ? last : null;
}

/**
 * Baut ein `mkt-sig-1`-Signal aus Kerzen. Nur Kerzen, deren Close zum
 * Entscheidungszeitpunkt bereits verfügbar ist, gehen ein.
 *
 * timeBasis "open": `time` ist die Open-Zeit; verfügbar bei time + barDurationMs.
 * timeBasis "close": `time` ist der Zeitpunkt, zu dem der Close der Engine
 * bekannt ist (Backtest-Konvention). Kerzen mit time > asOf bleiben draußen.
 */
export function buildMarketSignal(args: {
  candles: readonly CandleLike[];
  asOfMs: number;
  barDurationMs: number;
  timeBasis: CandleTimeBasis;
  strategyClass: StrategyClassKey;
  computedAtMs: number;
}): SignalSnapshot {
  const duration = Number.isFinite(args.barDurationMs) && args.barDurationMs > 0 ? args.barDurationMs : 0;
  const usable = args.candles.filter((c) => {
    if (!Number.isFinite(c.time) || !Number.isFinite(c.close) || c.close <= 0) return false;
    const available = args.timeBasis === "open" ? c.time + duration : c.time;
    return available <= args.asOfMs;
  });
  const present = {
    close: false,
    ema9: false,
    ema21: false,
    rsi: false,
  };
  const base = (partial: Partial<SignalSnapshot> & { coverage: number | null }): SignalSnapshot => ({
    contractVersion: SIGNAL_CONTRACT_VERSION,
    semanticsVersion: SIGNAL_SEMANTICS_VERSION,
    featureVersion: SIGNAL_FEATURE_VERSION,
    modelVersion: SIGNAL_MODEL_VERSION,
    configVersion: SIGNAL_CONFIG_VERSION,
    direction: null,
    strength: null,
    confidence: null,
    calculatedAsOf: null,
    availableAt: null,
    computedAt: toIso(args.computedAtMs),
    strategyClass: args.strategyClass,
    migrationId: null,
    ...partial,
  });

  if (usable.length === 0) {
    return base({ coverage: 0 });
  }
  const last = usable[usable.length - 1];
  const availableAtMs = args.timeBasis === "open" ? last.time + duration : last.time;
  const closes = usable.map((c) => c.close);
  present.close = Number.isFinite(last.close) && last.close > 0;
  const ema9 = emaLastOrNull(closes, 9);
  const ema21 = emaLastOrNull(closes, 21);
  const rsi14 = rsiOrNull(closes);
  present.ema9 = ema9 != null;
  present.ema21 = ema21 != null;
  present.rsi = rsi14 != null;
  const coverage = round6(
    (Number(present.close) + Number(present.ema9) + Number(present.ema21) + Number(present.rsi)) / 4,
  );
  const timeFields = {
    calculatedAsOf: toIso(availableAtMs),
    availableAt: toIso(availableAtMs),
    coverage,
  };
  if (!present.close || ema9 == null || ema21 == null || rsi14 == null || closes.length < MARKET_SIGNAL_PARAMS.minCloses) {
    return base(timeFields);
  }
  const price = last.close;
  const emaSpread = (ema9 - ema21) / price;
  const spreadScore = clamp(emaSpread / MARKET_SIGNAL_PARAMS.spreadFullScale, -1, 1);
  const rsiScore = clamp((rsi14 - 50) / 50, -1, 1);
  const composite =
    MARKET_SIGNAL_PARAMS.spreadWeight * spreadScore + MARKET_SIGNAL_PARAMS.rsiWeight * rsiScore;
  const direction: SignalDirection =
    composite > MARKET_SIGNAL_PARAMS.flatBand ? "LONG" : composite < -MARKET_SIGNAL_PARAMS.flatBand ? "SHORT" : "FLAT";
  const strength = round6(clamp(Math.abs(composite), 0, 1));
  return base({
    ...timeFields,
    direction,
    strength,
    confidence: coverage,
  });
}

export function unavailableSignal(args: {
  strategyClass: StrategyClassKey;
  computedAtMs: number;
}): SignalSnapshot {
  return {
    contractVersion: SIGNAL_CONTRACT_VERSION,
    semanticsVersion: SIGNAL_SEMANTICS_VERSION,
    featureVersion: SIGNAL_FEATURE_VERSION,
    modelVersion: SIGNAL_MODEL_VERSION,
    configVersion: SIGNAL_CONFIG_VERSION,
    direction: null,
    strength: null,
    confidence: null,
    calculatedAsOf: null,
    availableAt: null,
    computedAt: toIso(args.computedAtMs),
    coverage: 0,
    strategyClass: args.strategyClass,
    migrationId: null,
  };
}

// ── Decay-Entscheidung ──────────────────────────────────────────────────────

type BreachKind = "ABSOLUTE_DROP" | "RELATIVE_DROP" | "HALF_LIFE" | "REVERSAL";

function thresholdBreach(
  entryStrength: number,
  currentStrength: number,
  policy: ClassDecayPolicy,
): BreachKind | null {
  const absolute = entryStrength - currentStrength >= policy.absoluteDrop;
  const relative = entryStrength > 0 && (entryStrength - currentStrength) / entryStrength >= policy.relativeDrop;
  switch (policy.thresholdMode) {
    case "absolute":
      return absolute ? "ABSOLUTE_DROP" : null;
    case "relative":
      return relative ? "RELATIVE_DROP" : null;
    case "both":
      return absolute && relative ? "ABSOLUTE_DROP" : null;
    case "either":
    default:
      if (absolute) return "ABSOLUTE_DROP";
      if (relative) return "RELATIVE_DROP";
      return null;
  }
}

function opposite(side: "LONG" | "SHORT", direction: SignalDirection): boolean {
  return (side === "LONG" && direction === "SHORT") || (side === "SHORT" && direction === "LONG");
}

function selectBreach(
  entry: SignalSnapshot,
  current: SignalSnapshot,
  side: "LONG" | "SHORT",
  holdMs: number,
  policy: ClassDecayPolicy,
): BreachKind | null {
  const entryStrength = entry.strength as number;
  const currentStrength = current.strength as number;
  const reversal =
    policy.reversalEnabled &&
    opposite(side, current.direction as SignalDirection) &&
    currentStrength >= policy.reversalMinStrength &&
    (current.confidence as number) >= policy.reversalMinConfidence;
  if (reversal) return "REVERSAL";
  if (
    policy.halfLifeMs != null &&
    holdMs >= policy.halfLifeMs &&
    entryStrength > 0 &&
    currentStrength <= entryStrength * policy.halfLifeRemainingRatio
  ) {
    return "HALF_LIFE";
  }
  return thresholdBreach(entryStrength, currentStrength, policy);
}

function emptyEval(
  partial: Pick<SignalDecayEvaluation, "status" | "reasonCode" | "reason"> &
    Partial<SignalDecayEvaluation>,
  config: SignalDecayConfig,
  strategyClass: StrategyClassKey,
): SignalDecayEvaluation {
  return {
    breach: false,
    breachKind: null,
    shouldExit: false,
    wouldExit: false,
    newlyConfirmed: false,
    streak: partial.streak ?? 0,
    streakChanged: partial.streakChanged ?? false,
    observationKey: partial.observationKey ?? null,
    duplicate: partial.duplicate ?? false,
    coverage: partial.coverage ?? null,
    entryStrength: partial.entryStrength ?? null,
    currentStrength: partial.currentStrength ?? null,
    entryConfidence: partial.entryConfidence ?? null,
    currentConfidence: partial.currentConfidence ?? null,
    migrationId: partial.migrationId ?? null,
    counterfactualPnl: partial.counterfactualPnl ?? null,
    audit: partial.audit ?? null,
    policyVersion: partial.policyVersion ?? policyVersionOf(config),
    strategyClass,
    ...partial,
  };
}

/**
 * Reine Decay-Bewertung. Mutiert die Eingabe nicht. `shouldExit` ist nur true
 * im Modus `active`, bei bestätigtem Breach, ohne Kill-Switch und ohne
 * Duplikat-Beobachtung.
 */
export function evaluateSignalDecay(input: SignalDecayInput): SignalDecayEvaluation {
  const config = input.config;
  const strategyClass = classKey(input.strategyClass);
  const policy = config.classes[strategyClass];
  const policyVersion = policyVersionOf(config);
  const mtm = markToMarketPnl(input.side, input.qty, input.entryPrice, input.markPrice);

  if (config.mode === "off" || input.mode === "off") {
    return emptyEval(
      { status: "OFF", reasonCode: "MODE_OFF", reason: "Signal-Decay-Modus ist off — keine Bewertung, kein Exit." },
      config,
      strategyClass,
    );
  }
  if (!policy.enabled) {
    return emptyEval(
      {
        status: "DISABLED",
        reasonCode: "DISABLED",
        reason: `Strategieklasse ${strategyClass} ist default-off / nicht aktiviert — kein Signal-Exit.`,
        policyVersion,
      },
      config,
      strategyClass,
    );
  }

  const streakIn = Number.isFinite(input.confirmation.streak) && input.confirmation.streak > 0
    ? Math.trunc(input.confirmation.streak)
    : 0;
  const policyChanged =
    input.confirmation.policyVersion != null && input.confirmation.policyVersion !== policyVersion;
  const baseStreak = policyChanged ? 0 : streakIn;

  const assessed = assessCompatibility(
    input.entry,
    input.current,
    input.asOfMs,
    policy,
    config.acceptedMigrations,
  );

  const frozen = (status: SignalCompatibilityStatus, code: SignalDecayReasonCode, reason: string): SignalDecayEvaluation => {
    const evaln = emptyEval(
      {
        status,
        reasonCode: code,
        reason,
        policyVersion,
        streak: baseStreak,
        streakChanged: policyChanged,
        coverage: assessed.current?.coverage ?? null,
        entryStrength: assessed.entry?.strength ?? input.entry?.strength ?? null,
        currentStrength: assessed.current?.strength ?? null,
        entryConfidence: assessed.entry?.confidence ?? input.entry?.confidence ?? null,
        currentConfidence: assessed.current?.confidence ?? null,
        migrationId: assessed.migrationId,
      },
      config,
      strategyClass,
    );
    return { ...evaln, audit: buildAudit(input, evaln, policy) };
  };

  if (assessed.status === "MISSING") {
    const code = assessed.reason === "MISSING_ENTRY" || assessed.reason === "ENTRY_INCOMPLETE"
      ? "MISSING_ENTRY"
      : "MISSING_CURRENT";
    return frozen(assessed.status, code, `Signal nicht vergleichbar (${assessed.reason}) — kein Exit, Zählung eingefroren.`);
  }
  if (assessed.status === "STALE") {
    return frozen("STALE", "STALE", "Aktuelles Signal ist älter als maxStalenessMs — kein Exit, Zählung eingefroren.");
  }
  if (assessed.status === "INCOMPATIBLE") {
    return frozen("INCOMPATIBLE", "INCOMPATIBLE", `Signalversion inkompatibel (${assessed.reason}) — kein Exit.`);
  }
  if (assessed.status === "INVALID") {
    return frozen("INVALID", "INVALID", `Signal invalide (${assessed.reason}) — kein Exit, keine Null-Substitution.`);
  }
  if (assessed.status === "FUTURE") {
    return frozen("FUTURE", "FUTURE", "Signal liegt nach der Entscheidungszeit (Look-ahead) — verworfen, kein Exit.");
  }
  if (assessed.status === "LOW_COVERAGE") {
    return frozen("LOW_COVERAGE", "LOW_COVERAGE", "Coverage unter der Klassen-Schwelle — kein Exit, unbekannt bleibt unbekannt.");
  }

  const entry = assessed.entry as SignalSnapshot;
  const current = assessed.current as SignalSnapshot;
  const obsKey = observationKeyOf(current);
  const holdMs = input.asOfMs - input.openedAtMs;
  const holdOk = Number.isFinite(holdMs) && holdMs >= policy.minHoldMs;

  if (obsKey != null && !policyChanged && obsKey === input.confirmation.lastObservationKey) {
    const evaln = emptyEval(
      {
        status: "COMPATIBLE",
        reasonCode: "DUPLICATE_OBSERVATION",
        reason: "Dieselbe Beobachtung wurde bereits gezählt — kein zweiter Schritt, kein nachträglicher Exit.",
        policyVersion,
        streak: baseStreak,
        observationKey: obsKey,
        duplicate: true,
        coverage: current.coverage,
        entryStrength: entry.strength,
        currentStrength: current.strength,
        entryConfidence: entry.confidence,
        currentConfidence: current.confidence,
        migrationId: assessed.migrationId,
        counterfactualPnl: mtm,
      },
      config,
      strategyClass,
    );
    return { ...evaln, audit: buildAudit(input, evaln, policy) };
  }

  const breachKind = selectBreach(entry, current, input.side, holdMs, policy);
  if (breachKind != null && !holdOk) {
    const evaln = emptyEval(
      {
        status: "COMPATIBLE",
        reasonCode: "MIN_HOLD",
        reason: "Decay-Kandidat vor Mindesthaltedauer — zählt nicht und setzt die Bestätigung nicht zurück.",
        policyVersion,
        breach: false,
        breachKind,
        streak: baseStreak,
        streakChanged: policyChanged,
        observationKey: obsKey,
        coverage: current.coverage,
        entryStrength: entry.strength,
        currentStrength: current.strength,
        entryConfidence: entry.confidence,
        currentConfidence: current.confidence,
        migrationId: assessed.migrationId,
        counterfactualPnl: mtm,
      },
      config,
      strategyClass,
    );
    return { ...evaln, audit: buildAudit(input, evaln, policy) };
  }

  const nextStreak = breachKind != null ? baseStreak + 1 : 0;
  const confirmed = breachKind != null && nextStreak >= policy.confirmationCount;
  const newlyConfirmed = confirmed && baseStreak < policy.confirmationCount;
  const mode = input.mode === "active" || input.mode === "monitor" ? input.mode : config.mode;
  const suppressed = confirmed && input.killSwitchArmed;
  const shouldExit = confirmed && mode === "active" && !suppressed;
  const wouldExit = confirmed && !suppressed;
  let reasonCode: SignalDecayReasonCode = "HOLD";
  if (suppressed) reasonCode = "SUPPRESSED_KILL_SWITCH";
  else if (shouldExit) reasonCode = "EXIT";
  else if (wouldExit) reasonCode = "WOULD_EXIT";
  else if (breachKind != null) reasonCode = "CONFIRMING";
  const reason = suppressed
    ? "Bestätigter Signal-Verfall, aber Kill-Switch ist bewaffnet — Flatten besitzt den Close, SIGNAL_DECAY wird nicht gesetzt."
    : shouldExit
      ? `Bestätigter Signal-Verfall (${breachKind}) — Exit SIGNAL_DECAY.`
      : wouldExit
        ? `Bestätigter Signal-Verfall (${breachKind}) im Monitor-Modus — Counterfactual, kein Close.`
        : breachKind != null
          ? `Breach ${breachKind}, Bestätigung ${nextStreak}/${policy.confirmationCount} — noch kein Exit.`
          : "Kompatibles Signal ohne Decay/Reversal — Bestätigung zurückgesetzt.";

  const evaln = emptyEval(
    {
      status: "COMPATIBLE",
      reasonCode,
      reason,
      policyVersion,
      breach: breachKind != null,
      breachKind,
      shouldExit,
      wouldExit,
      newlyConfirmed,
      streak: nextStreak,
      streakChanged: nextStreak !== streakIn || policyChanged,
      observationKey: obsKey,
      coverage: current.coverage,
      entryStrength: entry.strength,
      currentStrength: current.strength,
      entryConfidence: entry.confidence,
      currentConfidence: current.confidence,
      migrationId: assessed.migrationId,
      counterfactualPnl: wouldExit || shouldExit ? mtm : null,
    },
    config,
    strategyClass,
  );
  return { ...evaln, audit: buildAudit(input, evaln, policy) };
}

/**
 * Audit-Payload. Zeitstempel nach `asOf` werden nicht übernommen (Look-ahead
 * darf im Audit nicht als verwendetes Signal erscheinen). Externe Texte werden
 * nicht eingebettet.
 */
export function buildAudit(
  input: SignalDecayInput,
  evaluation: SignalDecayEvaluation,
  policy: ClassDecayPolicy,
): SignalDecayAudit {
  const asOfIso = toIso(input.asOfMs);
  const keep = (iso: string | null | undefined): string | null => {
    const ms = parseIsoMs(iso ?? null);
    if (ms == null) return null;
    if (ms > input.asOfMs) return null;
    return new Date(ms).toISOString();
  };
  return {
    policyVersion: evaluation.policyVersion,
    policyReason: evaluation.reasonCode,
    strategyClass: evaluation.strategyClass,
    coverage: evaluation.coverage,
    semanticsVersion: input.current?.semanticsVersion ?? input.entry?.semanticsVersion ?? null,
    featureVersion: input.current?.featureVersion ?? input.entry?.featureVersion ?? null,
    modelVersion: input.current?.modelVersion ?? input.entry?.modelVersion ?? null,
    configVersion: input.current?.configVersion ?? input.entry?.configVersion ?? null,
    migrationId: evaluation.migrationId,
    entryDirection: input.entry?.direction ?? null,
    entryStrength: evaluation.entryStrength,
    entryConfidence: evaluation.entryConfidence,
    currentDirection: evaluation.reasonCode === "FUTURE" ? null : input.current?.direction ?? null,
    currentStrength: evaluation.reasonCode === "FUTURE" ? null : evaluation.currentStrength,
    currentConfidence: evaluation.reasonCode === "FUTURE" ? null : evaluation.currentConfidence,
    entryCalculatedAsOf: keep(input.entry?.calculatedAsOf),
    entryAvailableAt: keep(input.entry?.availableAt),
    currentCalculatedAsOf: evaluation.reasonCode === "FUTURE" ? null : keep(input.current?.calculatedAsOf),
    currentAvailableAt: evaluation.reasonCode === "FUTURE" ? null : keep(input.current?.availableAt),
    asOf: asOfIso,
    computedAt: asOfIso,
    confirmStreak: evaluation.streak,
    confirmationRequired: policy.confirmationCount,
    counterfactualPnl: evaluation.counterfactualPnl,
    mode: input.mode,
  };
}

export type CounterfactualClose = {
  positionId: string;
  realizedPnl: number | null;
};

export type SignalDecayEventView = {
  positionId: string;
  outcome: string;
  asOfMs: number;
  counterfactualPnl: number | null;
  compatible: boolean;
};

export type SignalDecayRollup = {
  /** Bewertungen mit aktivierter Klasse (Nenner). 0 ⇒ Coverage null, nicht 0. */
  evaluated: number;
  compatible: number;
  /** compatible / evaluated. null, wenn nichts bewertet wurde. */
  triggerCoverage: number | null;
  wouldExitEvents: number;
  wouldExitPositions: number;
  /** Summe der MTM zum ersten Would-Exit je Position (offene inklusive). */
  counterfactualMtmSum: number | null;
  /** Noch offene Would-Exits: MTM, Outcome unbekannt. */
  openCounterfactualMtm: number | null;
  /**
   * Nach tatsächlichem Close: max(0, MTM_would_exit − realized).
   * Positiv = der Signal-Exit hätte zusätzliches PnL gesichert.
   */
  additionalPnl: number | null;
  /**
   * Nach tatsächlichem Close: max(0, realized − MTM_would_exit).
   * Positiv = das Nicht-Schließen (Monitor) hat diesen Betrag erhalten.
   */
  avoidedPnl: number | null;
  closedCompared: number;
};

/**
 * Rollup der Monitor-only-Counterfactuals. Erstes Would-Exit je Position
 * (frühestes asOf) ist die Referenz. Unbekanntes realizedPnl bleibt draußen
 * (nicht 0).
 */
export function summarizeSignalDecay(events: readonly SignalDecayEventView[], closes: readonly CounterfactualClose[]): SignalDecayRollup {
  const evaluated = events.length;
  const compatible = events.filter((e) => e.compatible).length;
  const triggerCoverage = evaluated === 0 ? null : round6(compatible / evaluated);
  const would = events.filter((e) => e.outcome === "WOULD_EXIT" || e.outcome === "EXIT" || e.outcome === "SUPPRESSED_KILL_SWITCH");
  const firstByPosition = new Map<string, SignalDecayEventView>();
  const ordered = [...would].sort((a, b) => a.asOfMs - b.asOfMs || a.positionId.localeCompare(b.positionId));
  for (const ev of ordered) {
    if (!firstByPosition.has(ev.positionId)) firstByPosition.set(ev.positionId, ev);
  }
  const closeById = new Map(closes.map((c) => [c.positionId, c.realizedPnl]));
  let mtmSum = 0;
  let mtmCount = 0;
  let openMtm = 0;
  let openCount = 0;
  let additional = 0;
  let avoided = 0;
  let closedCompared = 0;
  let additionalCount = 0;
  for (const ev of firstByPosition.values()) {
    if (ev.counterfactualPnl == null) continue;
    mtmSum += ev.counterfactualPnl;
    mtmCount += 1;
    if (!closeById.has(ev.positionId)) {
      openMtm += ev.counterfactualPnl;
      openCount += 1;
      continue;
    }
    const realized = closeById.get(ev.positionId);
    if (realized == null || !Number.isFinite(realized)) continue;
    closedCompared += 1;
    additional += Math.max(0, ev.counterfactualPnl - realized);
    avoided += Math.max(0, realized - ev.counterfactualPnl);
    additionalCount += 1;
  }
  return {
    evaluated,
    compatible,
    triggerCoverage,
    wouldExitEvents: would.length,
    wouldExitPositions: firstByPosition.size,
    counterfactualMtmSum: mtmCount === 0 ? null : round6(mtmSum),
    openCounterfactualMtm: openCount === 0 ? null : round6(openMtm),
    additionalPnl: additionalCount === 0 ? null : round6(additional),
    avoidedPnl: additionalCount === 0 ? null : round6(avoided),
    closedCompared,
  };
}

const SDC_FIELDS = [
  "enabled",
  "absoluteDrop",
  "relativeDrop",
  "reversalEnabled",
  "reversalMinStrength",
  "reversalMinConfidence",
  "minHoldMs",
  "confirmationCount",
  "halfLifeMs",
  "halfLifeRemainingRatio",
  "maxStalenessMs",
  "minCoverage",
] as const;

/**
 * Klemmt einen einzelnen `sdc.<class>.<field>`-Override auf die Bounds.
 * Unbekannte Schlüssel werden abgelehnt (kein stilles Ignorieren auf dem
 * Schreibpfad — der Lese-Pfad ignoriert sie weiter).
 */
export function previewSignalDecayOverride(
  key: string,
  value: number,
): { ok: true; stored: number; strategyClass: StrategyClassKey; field: string } | { ok: false; error: string } {
  if (!key.startsWith("sdc.") || !Number.isFinite(value)) {
    return { ok: false, error: "Signal-Decay-Schlüssel muss sdc.<klasse>.<feld> sein" };
  }
  const parts = key.split(".");
  if (parts.length !== 3) return { ok: false, error: "Signal-Decay-Schlüssel muss sdc.<klasse>.<feld> sein" };
  const token = parts[1] === "mean_reversion" ? "mean-reversion" : parts[1];
  if (!isStrategyClassKey(token)) return { ok: false, error: `Unbekannte Strategieklasse: ${parts[1]}` };
  const field = parts[2];
  if (!SDC_FIELDS.includes(field as (typeof SDC_FIELDS)[number])) {
    return { ok: false, error: `Unbekanntes Signal-Decay-Feld: ${field}` };
  }
  const patch: Partial<ClassDecayPolicy> =
    field === "enabled" || field === "reversalEnabled"
      ? { [field]: value >= 1 }
      : field === "halfLifeMs"
        ? { halfLifeMs: value <= 0 ? null : value }
        : { [field]: value };
  const resolved = resolveSignalDecayConfig({
    classes: { [token]: patch },
  });
  const policy = resolved.classes[token];
  if (field === "enabled" || field === "reversalEnabled") {
    return { ok: true, stored: policy[field] ? 1 : 0, strategyClass: token, field };
  }
  if (field === "halfLifeMs") {
    return { ok: true, stored: policy.halfLifeMs ?? 0, strategyClass: token, field };
  }
  const stored = policy[field as keyof ClassDecayPolicy];
  return { ok: true, stored: typeof stored === "number" ? stored : value, strategyClass: token, field };
}

/** Numerische risk_config-Overrides (`sdc.<class>.<field>` = Zahl). Unbekannte Keys werden ignoriert. */
export function applyRiskConfigNumbers(
  config: SignalDecayConfig,
  rows: readonly { key: string; value: number }[],
): SignalDecayConfig {
  const classes: Partial<Record<StrategyClassKey, Partial<ClassDecayPolicy>>> = {};
  const fieldOf = (suffix: string): keyof ClassDecayPolicy | null => {
    switch (suffix) {
      case "enabled":
      case "absoluteDrop":
      case "relativeDrop":
      case "reversalEnabled":
      case "reversalMinStrength":
      case "reversalMinConfidence":
      case "minHoldMs":
      case "confirmationCount":
      case "halfLifeMs":
      case "halfLifeRemainingRatio":
      case "maxStalenessMs":
      case "minCoverage":
        return suffix;
      default:
        return null;
    }
  };
  const classOf = (token: string): StrategyClassKey | null => {
    if (token === "trend" || token === "breakout" || token === "unclassified" || token === "mean-reversion") return token;
    if (token === "mean_reversion") return "mean-reversion";
    return null;
  };
  for (const row of rows) {
    if (!row.key.startsWith("sdc.") || !Number.isFinite(row.value)) continue;
    const parts = row.key.split(".");
    if (parts.length !== 3) continue;
    const cls = classOf(parts[1] ?? "");
    const field = fieldOf(parts[2] ?? "");
    if (!cls || !field) continue;
    const patch = (classes[cls] ??= {});
    if (field === "enabled" || field === "reversalEnabled") {
      patch[field] = row.value >= 1;
    } else if (field === "halfLifeMs") {
      patch.halfLifeMs = row.value <= 0 ? null : row.value;
    } else if (field === "confirmationCount") {
      patch.confirmationCount = row.value;
    } else {
      (patch as Record<string, number>)[field] = row.value;
    }
  }
  return resolveSignalDecayConfig({
    mode: config.mode,
    acceptedMigrations: config.acceptedMigrations,
    classes: STRATEGY_CLASS_KEYS.reduce((acc, key) => {
      acc[key] = { ...config.classes[key], ...classes[key] };
      return acc;
    }, {} as Partial<Record<StrategyClassKey, Partial<ClassDecayPolicy>>>),
  });
}
