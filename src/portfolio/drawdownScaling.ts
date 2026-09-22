/**
 * Hysteretisches Drawdown-Risk-Scaling (RMA-P5-04, v1.68.0).
 *
 * Der KERN ist hier: eine **pure, deterministische** Policy-Funktion, die aus
 * einer reconcilten Equity-Beobachtung und dem persistierten High-Water-Mark
 * (HWM) eine monotone, geboundede Risikoreduktion mit Hysterese/Cooldown
 * ableitet. Sie ist frei von Uhr, Zufall und I/O — damit vollständig
 * unit-testbar und für Replay/Restart reproduzierbar.
 *
 * ── Warum überhaupt? ────────────────────────────────────────────────────────
 * `maxEquityDrawdownPct` (Kill-Switch) und `dailyLossLimitPct` sind HARTSCHALTER:
 * Sie greifen erst, wenn der Verlust bereits eingetreten ist. Zwischen „alles
 * gut“ und „Not-Halt“ gab es bisher keine kontinuierliche Reaktion auf einen
 * laufenden Drawdown. Diese Policy schiebt die Reduktion VOR den Kill-Switch:
 *
 *   NORMAL  dd ≤ soft            Faktor 1 (volles Basis-Risikobudget)
 *   SOFT    soft < dd < hard     linear 1 → minFactor (monoton fallend)
 *   DEEP    dd ≥ hard            Faktor = minFactor (Boden)
 *   PAUSE   dd ≥ pauseThreshold  Faktor = minFactor + Block neuer Einstiege
 *
 * ── Hysterese (verbindlich) ─────────────────────────────────────────────────
 *   - **Degradation ist SOFORT und ungebounded in der Zeit**: steigt der
 *     Drawdown, sinkt der Faktor im selben Schritt auf den Kurvenwert
 *     (`applied = min(applied, target)`). Die sichere Richtung wird nie
 *     verzögert.
 *   - **Recovery ist gebounded und bestätigt**: der Faktor darf frühestens
 *     `recoveryCooldownMs` nach der letzten Degradation steigen, nur nach
 *     `recoveryConfirmations` aufeinanderfolgenden Bewertungen mit
 *     `target > applied` und dann höchstens um `recoveryStep` je Bewertung.
 *     Flapping (rein-raus-rein) ist damit strukturell ausgeschlossen.
 *
 * ── Equity, Cashflows und High-Water-Mark ───────────────────────────────────
 * Der HWM wird über die **cashflow-bereinigte** Equity geführt:
 *
 *   adjustedEquity_t = equity_t − cumulativeNetFlow_t
 *   HWM_t            = max(HWM_{t−1}, adjustedEquity_t)      (nie fallend)
 *   drawdown_t       = (HWM_t − adjustedEquity_t) / HWM_t
 *
 * Der Netto-Cashflow wird aus dem **nicht durch Trading-PnL erklärten**
 * Equity-Sprung abgeleitet:
 *
 *   residual_t = (equity_t − equity_{t−1}) − (tradingPnl_t − tradingPnl_{t−1})
 *
 * Überschreitet `|residual_t|` die Toleranz
 * `max(cashflowToleranceAbs, cashflowTolerancePct · equity)`, gilt er als
 * externe Ein-/Auszahlung und wird dem `cumulativeNetFlow` zugeschlagen: eine
 * Einzahlung erzeugt damit **keinen** neuen HWM, eine Auszahlung **keinen**
 * falschen Drawdown.
 *
 * Ist die Trading-PnL-Attribution nicht verfügbar (`null`/unvollständig ist
 * NICHT `0`) oder liegt die Vorbewertung zu weit zurück, wird der Sprung NICHT
 * als Cashflow neutralisiert. Diese Richtung ist bewusst fail-closed: ein
 * nicht erkannter Zufluss erhöht den HWM und macht den gemessenen Drawdown
 * später **größer** (nur senkendes Risiko), niemals kleiner.
 *
 * ── Fail-closed ─────────────────────────────────────────────────────────────
 * Fehlende, stale, invalide oder nicht abgeglichene Equity führt NIEMALS still
 * zu „neutral“:
 *
 *   - Status `CONSERVATIVE` ⇒ `appliedFactor = minFactor` SOFORT (bypassed jede
 *     Hysterese), `drawdownPct = null` (unbekannt ≠ 0), HWM bleibt erhalten;
 *   - Reason-Codes sind geschlossen und bounded (`NO_EQUITY`, `STALE_EQUITY`,
 *     `INVALID_EQUITY`, `FUTURE_EQUITY`, `RECONCILIATION_MISSING`,
 *     `RECONCILIATION_STALE`, `RECONCILIATION_FAILED`);
 *   - ein Equity-Zeitstempel in der Zukunft (Look-ahead-Verdacht) ist ein
 *     Strukturverstoß und wird hart abgelehnt.
 *
 * ── Ziele/Grenzen ───────────────────────────────────────────────────────────
 * Der Faktor ist hart auf `[minFactor, 1]` mit `minFactor > 0` gebounded: er
 * kann das konfigurierte Basis-Risikobudget (`maxRiskPerTrade`) **niemals
 * überschreiten**. Risk-Ceilings, Kill-Switches, Authority Chains und
 * Live-Gates bleiben unverändert — die Komposition mit Regime- und
 * Volatility-Targeting-Faktor passiert in `src/lib/riskGuard.ts`
 * („nur senken, nie aufweiten“).
 */

import { createHash } from "node:crypto";

import { canonicalJsonStringify } from "./volatilityTargeting";

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Betriebsmodus des Drawdown-Risk-Scalings:
 *   - `off`     — aus (keine Bewertung, keine Persistenz, kein Faktor).
 *   - `monitor` — Bewertung + Persistenz + Reporting, KEINE Größenänderung
 *                 (risikoneutraler Rollout-Start, Default).
 *   - `active`  — Faktor (und ggf. PAUSE) wirken auf neue Einstiege.
 */
export type DrawdownScalingMode = "off" | "monitor" | "active";

export const DRAWDOWN_SCALING_MODES: readonly DrawdownScalingMode[] = ["off", "monitor", "active"];

/**
 * Stufe der Policy (geschlossenes, persistierbares Vokabular).
 *
 *   NORMAL — dd ≤ softThresholdPct                (Faktor 1)
 *   SOFT   — soft < dd < hard                     (Faktor ∈ (minFactor, 1))
 *   DEEP   — dd ≥ hard (oder CONSERVATIVE)        (Faktor = minFactor)
 *   PAUSE  — dd ≥ pauseThresholdPct (> 0)         (Faktor = minFactor + Block)
 */
export type DrawdownStage = "NORMAL" | "SOFT" | "DEEP" | "PAUSE";

export const DRAWDOWN_STAGES: readonly DrawdownStage[] = ["NORMAL", "SOFT", "DEEP", "PAUSE"];

/** Rohe (ungvalidierte) Policy-Konfiguration — z. B. aus `risk_config` (`dsp.*`). */
export interface DrawdownScalingConfig {
  /** Master-Schalter (Default true). */
  enabled: boolean;
  /** Betriebsmodus (Default `monitor`). */
  mode: DrawdownScalingMode;
  /** Drawdown in PROZENT, ab dem die Reduktion beginnt (Soft-Schwelle, 5 = 5 %). */
  softThresholdPct: number;
  /** Drawdown in PROZENT, ab dem `minFactor` erreicht ist (Hard-Schwelle). */
  hardThresholdPct: number;
  /** Untergrenze des Faktors (> 0) — niedrigster erlaubter Kurvenwert. */
  minFactor: number;
  /**
   * Optionaler PAUSE-Schwellwert in PROZENT: ab diesem Drawdown werden NEUE
   * Einstiege blockiert (`0` = PAUSE deaktiviert). Wird immer auf
   * `≥ hardThresholdPct` normalisiert.
   */
  pauseThresholdPct: number;
  /** Maximales Alter der Equity-Beobachtung (ms) — sonst `STALE_EQUITY`. */
  maxEquityStalenessMs: number;
  /** Reconciliation-Gate aktiv? (Default true — fail-closed). */
  requireReconciliation: boolean;
  /** Maximales Alter des letzten Reconciliation-Berichts (ms). */
  reconciliationMaxAgeMs: number;
  /** Wartezeit nach einer Degradation, bevor der Faktor steigen darf (ms). */
  recoveryCooldownMs: number;
  /**
   * Anzahl bestätigter Erholungsbewertungen vor dem ersten Recovery-Schritt.
   * Gezählt werden NUR Bewertungen nach Ablauf des Cooldowns — eine Erholung
   * während des Cooldowns kann den Faktor nicht früher heben.
   */
  recoveryConfirmations: number;
  /** Maximaler Faktorzuwachs je bestätigtem Recovery-Schritt. */
  recoveryStep: number;
  /** Absolute Toleranz der Cashflow-Erkennung (Kontowährung). */
  cashflowToleranceAbs: number;
  /** Relative Toleranz der Cashflow-Erkennung (Anteil der Equity). */
  cashflowTolerancePct: number;
  /** Bootstrap: HWM beim ersten Lauf ≥ Startkapital (kein Reset durch Deployment). */
  bootstrapFromBaseline: boolean;
}

/**
 * Werte (Default = risikoneutraler Rollout: `monitor`).
 *
 * Die Schwellen liegen bewusst UNTER dem Kill-Switch-Default
 * (`maxEquityDrawdownPct = 0.15`): die Reduktion beginnt bei 5 %, erreicht den
 * Boden bei 12 % und blockiert neue Einstiege (falls aktiviert) ab 15 % — der
 * Not-Halt bleibt die letzte Instanz, greift aber erst nach der Entschärfung.
 */
export const DEFAULT_DRAWDOWN_SCALING_CONFIG: DrawdownScalingConfig = {
  enabled: true,
  mode: "monitor",
  softThresholdPct: 5,
  hardThresholdPct: 12,
  minFactor: 0.25,
  pauseThresholdPct: 0,
  maxEquityStalenessMs: 15 * 60_000,
  requireReconciliation: true,
  reconciliationMaxAgeMs: 6 * 3600_000,
  recoveryCooldownMs: 6 * 3600_000,
  recoveryConfirmations: 3,
  recoveryStep: 0.05,
  cashflowToleranceAbs: 0.05,
  cashflowTolerancePct: 0.001,
  bootstrapFromBaseline: true,
};

/** Erlaubtes Fenster pro Feld — alle Quellen werden hiergegen geklemmt. */
export const DRAWDOWN_SCALING_BOUNDS: Record<keyof DrawdownScalingConfig, [min: number, max: number]> = {
  enabled: [0, 1],
  mode: [0, 0], // Modus wird separat validiert (kein numerisches Fenster)
  softThresholdPct: [0.1, 50],
  hardThresholdPct: [1, 80],
  minFactor: [0.05, 1],
  pauseThresholdPct: [0, 100],
  maxEquityStalenessMs: [60_000, 24 * 3600_000],
  requireReconciliation: [0, 1],
  reconciliationMaxAgeMs: [5 * 60_000, 7 * 86_400_000],
  recoveryCooldownMs: [0, 7 * 86_400_000],
  recoveryConfirmations: [1, 240],
  recoveryStep: [0.01, 1],
  cashflowToleranceAbs: [0, 1_000_000],
  cashflowTolerancePct: [0, 0.05],
  bootstrapFromBaseline: [0, 1],
};

/** Rohe Konfigurationsquelle (DB trägt NUMERIC, Env trägt Strings). */
export type DrawdownScalingConfigInput = Partial<
  Record<keyof DrawdownScalingConfig, number | boolean | string>
>;

/**
 * Löst eine Partial-Konfiguration in die voll validierte Form auf.
 *
 * Klemm-Regeln (Fail-safe, keine Ausnahmen):
 *   - numerische Werte: `clamp(v, min, max)` gegen
 *     {@link DRAWDOWN_SCALING_BOUNDS};
 *   - `hardThresholdPct` wird auf `> softThresholdPct` normalisiert (ein
 *     invertiertes/leeres Fenster ist Misskonfiguration, kein Fehlbetrieb);
 *   - `pauseThresholdPct > 0` wird auf `≥ hardThresholdPct` normalisiert;
 *   - `minFactor` hart `≤ 1` (der Faktor darf das Basis-Risikobudget niemals
 *     überschreiten — auch nicht durch Konfiguration);
 *   - ungültige Werte behalten den Basiswert (gleiche Konvention wie
 *     `resolveVolatilityTargetingConfig`).
 */
export function resolveDrawdownScalingConfig(
  raw: DrawdownScalingConfigInput = {},
  base: DrawdownScalingConfig = DEFAULT_DRAWDOWN_SCALING_CONFIG
): DrawdownScalingConfig {
  const next: DrawdownScalingConfig = { ...base };

  const num = (field: keyof DrawdownScalingConfig): number | undefined => {
    const v = raw[field];
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  if (raw.enabled !== undefined) {
    next.enabled = raw.enabled === true || Number(raw.enabled) >= 0.5;
  }
  if (raw.requireReconciliation !== undefined) {
    next.requireReconciliation = raw.requireReconciliation === true || Number(raw.requireReconciliation) >= 0.5;
  }
  if (raw.bootstrapFromBaseline !== undefined) {
    next.bootstrapFromBaseline = raw.bootstrapFromBaseline === true || Number(raw.bootstrapFromBaseline) >= 0.5;
  }
  if (raw.mode !== undefined) {
    const m = String(raw.mode).trim().toLowerCase();
    if ((DRAWDOWN_SCALING_MODES as readonly string[]).includes(m)) {
      next.mode = m as DrawdownScalingMode;
    }
  }

  for (const field of [
    "softThresholdPct",
    "hardThresholdPct",
    "minFactor",
    "pauseThresholdPct",
    "maxEquityStalenessMs",
    "reconciliationMaxAgeMs",
    "recoveryCooldownMs",
    "recoveryConfirmations",
    "recoveryStep",
    "cashflowToleranceAbs",
    "cashflowTolerancePct",
  ] as const) {
    const v = num(field);
    if (v === undefined) continue;
    const [min, max] = DRAWDOWN_SCALING_BOUNDS[field];
    (next[field] as number) = Math.min(Math.max(v, min), max);
  }

  // Ganzzahlfelder deterministisch runden.
  next.recoveryConfirmations = Math.round(next.recoveryConfirmations);
  next.maxEquityStalenessMs = Math.round(next.maxEquityStalenessMs);
  next.reconciliationMaxAgeMs = Math.round(next.reconciliationMaxAgeMs);
  next.recoveryCooldownMs = Math.round(next.recoveryCooldownMs);

  // Harte Invarianten (Reihenfolge + Bounds).
  next.hardThresholdPct = Math.max(
    next.hardThresholdPct,
    next.softThresholdPct + DRAWDOWN_SCALING_BOUNDS.softThresholdPct[0]
  );
  if (next.pauseThresholdPct > 0) {
    next.pauseThresholdPct = Math.max(next.pauseThresholdPct, next.hardThresholdPct);
  }
  next.minFactor = Math.min(next.minFactor, 1);
  if (!(next.minFactor > 0)) next.minFactor = DRAWDOWN_SCALING_BOUNDS.minFactor[0];

  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy-Kurve (monoton, stückweise, bounded)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Monotone, stückweise lineare Policy-Kurve Drawdown → Faktor.
 *
 * ```
 *   dd ≤ soft        : 1
 *   soft < dd < hard : 1 − (1 − minFactor) · (dd − soft) / (hard − soft)
 *   dd ≥ hard        : minFactor
 * ```
 *
 * Eigenschaften (durch Tests belegt):
 *   - **monoton nicht-steigend** in `dd` (mehr Drawdown ⇒ nie mehr Risiko),
 *   - Werte in `[minFactor, 1]` (nie risikosteigernd),
 *   - stetig an beiden Schwellen.
 *
 * Ein nicht-endlicher Eingabewert wird fail-closed als `minFactor` behandelt
 * (`null`/unbekannt ist nicht „0 Risiko“).
 */
export function drawdownTargetFactor(drawdownPct: number, config: DrawdownScalingConfig): number {
  if (!Number.isFinite(drawdownPct)) return config.minFactor;
  const dd = Math.min(Math.max(drawdownPct, 0), 1);
  const soft = config.softThresholdPct / 100;
  const hard = config.hardThresholdPct / 100;
  const min = config.minFactor;
  if (dd <= soft) return 1;
  if (dd >= hard) return min;
  const t = (dd - soft) / (hard - soft);
  return 1 - (1 - min) * t;
}

/**
 * Stufe zu einem Drawdown (geschlossenes Vokabular).
 * `paused` wird genau dann true, wenn ein PAUSE-Schwellwert konfiguriert ist
 * (`> 0`) UND der Drawdown ihn erreicht.
 */
export function drawdownStageFor(drawdownPct: number, config: DrawdownScalingConfig): DrawdownStage {
  const ddPct = Number.isFinite(drawdownPct) ? Math.min(Math.max(drawdownPct, 0), 1) * 100 : 100;
  if (config.pauseThresholdPct > 0 && ddPct >= config.pauseThresholdPct) return "PAUSE";
  if (ddPct >= config.hardThresholdPct) return "DEEP";
  if (ddPct > config.softThresholdPct) return "SOFT";
  return "NORMAL";
}

// ─────────────────────────────────────────────────────────────────────────────
// Beobachtung & Zustand
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trading-PnL der Beobachtung (kumuliert).
 *
 * `realized` = Summe realisierter PnL geschlossener Positionen,
 * `unrealized` = Bewertungs-PnL offener Positionen.
 *
 * **Beide Werte müssen endlich sein**, sonst gilt die Attribution als
 * `unverified` — `null` ist NICHT `0` (ein fehlender Wert darf nicht als
 * „kein PnL“ in die Cashflow-Erkennung eingehen).
 */
export interface DrawdownTradingPnl {
  realized: number | null;
  unrealized: number | null;
}

/** Reconciliation-Gate der Equity-Quelle (Broker ↔ DB). */
export interface DrawdownReconciliationGate {
  /** Zeitpunkt des letzten Reports (ms epoch) oder null (nie gelaufen). */
  at: number | null;
  /** true = ohne kritische Diskrepanz; false = kritisch; null = unbekannt. */
  clean: boolean | null;
}

/** Eine Equity-Beobachtung aus dem autoritativen, reconcilten Pfad. */
export interface DrawdownEquityObservation {
  /** Beobachtete Equity (Kontowährung). */
  equity: number;
  /** Verfügbarkeitszeit der Equity (ms epoch) — Frischegrenze. */
  availableAt: number;
  /** Startkapital/Baseline für den Bootstrap (optional; kein Reset bei Deploy). */
  baselineEquity?: number | null;
  /** Kumulierte Trading-PnL zum Beobachtungszeitpunkt (optional). */
  tradingPnl?: DrawdownTradingPnl | null;
  /** Reconciliation-Gate (optional; gated bei `requireReconciliation`). */
  reconciliation?: DrawdownReconciliationGate | null;
  /** Herkunft (Audit): z. B. `db-snapshot`, `paper-ledger`. */
  source?: string | null;
}

/**
 * Persistierter/rekonstruierter Policy-Zustand.
 *
 * **Wahrheit ist die Datenbank** (`drawdown_scaling_snapshots`, letzte Zeile);
 * die RAM-Kopie ist nur die Projektion. Ein Prozess-Neustart rekonstruiert
 * daraus denselben HWM und denselben Faktor — ein Deployment setzt den
 * High-Water-Mark nicht zurück.
 */
export interface DrawdownScalingState {
  /** Cashflow-bereinigter High-Water-Mark oder null (noch kein Bootstrap). */
  hwm: number | null;
  /** Zuletzt ANGEWENDETER Faktor ∈ (0, 1] oder null (Bootstrap ⇒ 1). */
  factor: number | null;
  /** Kumulierte erkannte Netto-Externcashflows (+ = Einzahlung). */
  cumulativeNetFlow: number | null;
  /** Equity der letzten Bewertung (Basis der Cashflow-Residuen). */
  lastEquity: number | null;
  /** Zeitpunkt der letzten Bewertung (ms epoch) — Frische der Residuen. */
  lastObservationAt: number | null;
  /** Trading-PnL der letzten Bewertung (realized+unrealized) oder null. */
  lastTradingPnl: number | null;
  /** Zeitpunkt der letzten Degradation (ms) — Cooldown-Basis. */
  lastDegradeAt: number | null;
  /** Zeitpunkt der letzten Faktor-/Stufentransition (ms). */
  lastTransitionAt: number | null;
  /** Aufeinanderfolgende bestätigte Erholungsbewertungen. */
  recoveryStreak: number;
  /** Stufe der letzten Bewertung (null = noch keine). */
  stage: DrawdownStage | null;
  /** Zuletzt persistierte Policyversion (`ddp1:<sha256>`) oder null. */
  policyVersion: string | null;
}

/** Leerer Ausgangszustand (erste Bewertung ⇒ Bootstrap). */
export const EMPTY_DRAWDOWN_SCALING_STATE: DrawdownScalingState = {
  hwm: null,
  factor: null,
  cumulativeNetFlow: null,
  lastEquity: null,
  lastObservationAt: null,
  lastTradingPnl: null,
  lastDegradeAt: null,
  lastTransitionAt: null,
  recoveryStreak: 0,
  stage: null,
  policyVersion: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Ergebnis-Vokabular
// ─────────────────────────────────────────────────────────────────────────────

/** Status der Bewertung. */
export type DrawdownScalingStatusKind =
  /** Erste Bewertung (HWM etabliert). */
  | "BOOTSTRAP"
  /** Normalpfad (Kurve + Hysterese). */
  | "OK"
  /** Fail-closed: fehlende/stale/invalide/unreconcilede Equity ⇒ minFactor. */
  | "CONSERVATIVE";

/** Geschlossene, bounded Reason-Codes (kein Freitext-Label). */
export type DrawdownScalingReasonCode =
  | "BOOTSTRAP"
  | "OK"
  | "NO_EQUITY"
  | "INVALID_EQUITY"
  | "FUTURE_EQUITY"
  | "STALE_EQUITY"
  | "RECONCILIATION_MISSING"
  | "RECONCILIATION_STALE"
  | "RECONCILIATION_FAILED";

export const DRAWDOWN_SCALING_REASON_CODES: readonly DrawdownScalingReasonCode[] = [
  "BOOTSTRAP",
  "OK",
  "NO_EQUITY",
  "INVALID_EQUITY",
  "FUTURE_EQUITY",
  "STALE_EQUITY",
  "RECONCILIATION_MISSING",
  "RECONCILIATION_STALE",
  "RECONCILIATION_FAILED",
];

/** Art der Zustandsänderung im Bewertungsschritt. */
export type DrawdownTransition = "NONE" | "DEGRADE" | "RECOVER" | "BOOTSTRAP";

export const DRAWDOWN_TRANSITIONS: readonly DrawdownTransition[] = [
  "NONE",
  "DEGRADE",
  "RECOVER",
  "BOOTSTRAP",
];

/** Cashflow-Attribution der Bewertung. */
export interface DrawdownCashflowInfo {
  /** In DIESEM Schritt erkannter Netto-Externcashflow (+ = Einzahlung). */
  detected: number;
  /** Kumulierte erkannte Netto-Externcashflows. */
  cumulative: number;
  /**
   * `verified` = Trading-PnL war vollständig verfügbar UND die Vorbewertung
   * frisch genug — Residuen wurden als Cashflow neutralisiert.
   * `unverified` = keine Neutralisierung (fail-closed: Zuflüsse erhöhen dann
   * den HWM und wirken nur senkend).
   */
  verification: "verified" | "unverified";
}

/** Vollständiges Ergebnis einer Bewertung. */
export interface DrawdownScalingEvaluation {
  status: DrawdownScalingStatusKind;
  reasonCode: DrawdownScalingReasonCode;
  /** Menschenlesbare Begründung (Audit/Status). */
  reason: string;
  /** Stufe (bei CONSERVATIVE: `DEEP`, weil der Faktor am Boden liegt). */
  stage: DrawdownStage;
  /** true = neue Einstiege blockiert (nur PAUSE-Stufe). */
  paused: boolean;
  /** Rohe beobachtete Equity oder null (nicht beobachtbar). */
  equity: number | null;
  /** Cashflow-bereinigte Equity oder null. */
  adjustedEquity: number | null;
  /** Cashflow-bereinigter High-Water-Mark (nach diesem Schritt) oder null. */
  hwm: number | null;
  /** Drawdown ∈ [0, 1] oder null (unbekannt ≠ 0). */
  drawdownPct: number | null;
  /** Kurvenwert (Ziel-Faktor) oder null (nicht berechenbar). */
  targetFactor: number | null;
  /** Vorheriger Faktor (1 = Bootstrap/Neutral). */
  prevFactor: number;
  /** Angewendeter Faktor ∈ [minFactor, 1] — IMMER endlich (fail-closed). */
  appliedFactor: number;
  /** Änderung gegenüber der Vorstufe (0 = unverändert). */
  factorDelta: number;
  transition: DrawdownTransition;
  /** Stufe der Vorbewertung (null = Bootstrap). */
  prevStage: DrawdownStage | null;
  /** Zeitpunkt der letzten Degradation (ms, aus dem neuen Zustand). */
  lastDegradeAt: number | null;
  /** Bestätigte Erholungsbewertungen (aus dem neuen Zustand). */
  recoveryStreak: number;
  /** Alter der Equity-Beobachtung relativ zu `computedAt` (ms) oder null. */
  equityAgeMs: number | null;
  /** Alter des Reconciliation-Reports (ms) oder null. */
  reconciliationAgeMs: number | null;
  /** Herkunft der Equity (Audit) oder null. */
  equitySource: string | null;
  cashflow: DrawdownCashflowInfo;
  /** Policyversion `ddp1:<sha256>` — historische Zeilen bleiben lesbar. */
  policyVersion: string;
  /** Neu zu persistierender Zustand (identisch rekonstruierbar). */
  nextState: DrawdownScalingState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bewertung (Kern der Policy)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bewertet eine Equity-Beobachtung gegen die Policy.
 *
 * Deterministisch und ohne Seiteneffekte: gleiche Eingabe (Beobachtung,
 * Zustand, Zeitstempel, Konfiguration) ⇒ bit-identisches Ergebnis.
 *
 * Reihenfolge (deterministisch, fail-closed vor jeder Optimierung):
 *   1. Equity vorhanden/endlich/positiv?
 *   2. Equity-Zeitstempel vorhanden, nicht in der Zukunft, nicht stale?
 *   3. Reconciliation-Gate (falls `requireReconciliation`)?
 *   4. Cashflow-Residuum → `cumulativeNetFlow`
 *   5. HWM (Bootstrap bzw. `max(HWM, adjustedEquity)`) → Drawdown
 *   6. Kurve → Ziel-Faktor; Hysterese (sofort senken, gebounded heben)
 */
export function evaluateDrawdownScaling(input: {
  observation: DrawdownEquityObservation;
  state?: DrawdownScalingState;
  /** Entscheidungszeitpunkt (ms). */
  asOf: number;
  /** Berechnungszeit (ms), normalerweise ≥ `asOf`. */
  computedAt: number;
  config: DrawdownScalingConfig;
}): DrawdownScalingEvaluation {
  const { observation, config } = input;
  const state: DrawdownScalingState = { ...EMPTY_DRAWDOWN_SCALING_STATE, ...(input.state ?? {}) };
  const asOf = Number(input.asOf);
  const computedAt = Number(input.computedAt);
  const policyVersion = hashDrawdownScalingPolicy(config);

  const prevFactor =
    state.factor !== null && Number.isFinite(state.factor) && state.factor > 0
      ? Math.min(state.factor, 1)
      : 1;
  const cumulativeNetFlow =
    state.cumulativeNetFlow !== null && Number.isFinite(state.cumulativeNetFlow)
      ? state.cumulativeNetFlow
      : 0;
  const equitySource = observation.source ?? null;
  const equity = observation.equity;
  const availableAt = observation.availableAt;
  const equityAgeMs =
    Number.isFinite(availableAt) && Number.isFinite(computedAt) ? computedAt - availableAt : null;
  const reconciliation = observation.reconciliation ?? null;
  const reconciliationAgeMs =
    reconciliation && reconciliation.at !== null && Number.isFinite(reconciliation.at)
      ? computedAt - reconciliation.at
      : null;

  /** Fail-closed-Ausgang: Faktor sofort auf den Boden, Zustand bleibt erhalten. */
  const conservative = (reasonCode: DrawdownScalingReasonCode, reason: string): DrawdownScalingEvaluation => {
    const applied = config.minFactor;
    const degraded = applied < prevFactor;
    const lastDegradeAt = degraded ? computedAt : state.lastDegradeAt;
    const transition: DrawdownTransition = degraded ? "DEGRADE" : "NONE";
    return {
      status: "CONSERVATIVE",
      reasonCode,
      reason,
      stage: "DEEP",
      paused: false,
      equity: Number.isFinite(equity) && equity > 0 ? equity : null,
      adjustedEquity: null,
      hwm: state.hwm,
      drawdownPct: null,
      targetFactor: null,
      prevFactor,
      appliedFactor: applied,
      factorDelta: applied - prevFactor,
      transition,
      prevStage: state.stage,
      lastDegradeAt,
      recoveryStreak: 0,
      equityAgeMs,
      reconciliationAgeMs,
      equitySource,
      cashflow: { detected: 0, cumulative: cumulativeNetFlow, verification: "unverified" },
      policyVersion,
      nextState: {
        ...state,
        factor: applied,
        recoveryStreak: 0,
        lastDegradeAt,
        lastTransitionAt: degraded ? computedAt : state.lastTransitionAt,
        stage: "DEEP",
        policyVersion,
      },
    };
  };

  // 1) Equity vorhanden & plausibel?
  if (equity === null || equity === undefined || !Number.isFinite(equity)) {
    return conservative(
      "NO_EQUITY",
      "keine endliche Equity-Beobachtung verfügbar — konservativer Faktor (fail-closed)"
    );
  }
  if (equity <= 0) {
    return conservative(
      "INVALID_EQUITY",
      `Equity ${equity} ist nicht positiv (insolvent/unplausibel) — konservativer Faktor`
    );
  }

  // 2) Zeitachse: Verfügbarkeit muss bekannt, nicht in der Zukunft und frisch sein.
  if (!Number.isFinite(availableAt) || availableAt <= 0) {
    return conservative(
      "NO_EQUITY",
      "Equity ohne gültigen Verfügbarkeitszeitstempel — Frische nicht verifizierbar"
    );
  }
  if (availableAt > computedAt) {
    return conservative(
      "FUTURE_EQUITY",
      // Kein Datumsformat im Kern: der Kern ist uhrfrei (Zeit wird injiziert),
      // deshalb nur das deterministische Delta — ISO-Zeiten liefert die
      // Orchestrierung/Audit-Schicht.
      `Equity-Zeitstempel liegt in der Zukunft (Δ ${Math.round(availableAt - computedAt)} ms) — Look-ahead-Verdacht, abgelehnt`
    );
  }
  if (equityAgeMs !== null && equityAgeMs > config.maxEquityStalenessMs) {
    return conservative(
      "STALE_EQUITY",
      `Equity ist ${Math.round(equityAgeMs / 60_000)} min alt (Limit ${Math.round(config.maxEquityStalenessMs / 60_000)} min) — konservativer Faktor`
    );
  }

  // 3) Reconciliation-Gate (Broker ↔ DB) — fail-closed, wenn gefordert.
  if (config.requireReconciliation) {
    if (!reconciliation || reconciliation.at === null || !Number.isFinite(reconciliation.at)) {
      return conservative(
        "RECONCILIATION_MISSING",
        "kein Reconciliation-Bericht vorhanden (Broker ↔ DB nicht abgeglichen) — konservativer Faktor"
      );
    }
    if (reconciliation.clean !== true) {
      return conservative(
        "RECONCILIATION_FAILED",
        "letzter Reconciliation-Lauf hat kritische Diskrepanzen gemeldet — konservativer Faktor"
      );
    }
    if (reconciliationAgeMs !== null && reconciliationAgeMs > config.reconciliationMaxAgeMs) {
      return conservative(
        "RECONCILIATION_STALE",
        `letzter Reconciliation-Bericht ist ${Math.round((reconciliationAgeMs ?? 0) / 60_000)} min alt (Limit ${Math.round(config.reconciliationMaxAgeMs / 60_000)} min) — konservativer Faktor`
      );
    }
  }

  // 4) Cashflow-Residuum (nur bei verifizierter Trading-PnL + frischer Vorbewertung).
  const pnl = observation.tradingPnl ?? null;
  const tradingPnl =
    pnl && Number.isFinite(pnl.realized) && Number.isFinite(pnl.unrealized)
      ? (pnl.realized as number) + (pnl.unrealized as number)
      : null;
  const prevObservationFresh =
    state.lastObservationAt !== null &&
    Number.isFinite(state.lastObservationAt) &&
    computedAt - state.lastObservationAt <= config.maxEquityStalenessMs;
  const attributionVerified =
    tradingPnl !== null && state.lastTradingPnl !== null && prevObservationFresh && state.lastEquity !== null;

  let detectedCashflow = 0;
  let nextCumulativeNetFlow = cumulativeNetFlow;
  if (attributionVerified) {
    const deltaEquity = equity - (state.lastEquity as number);
    const deltaPnl = tradingPnl - (state.lastTradingPnl as number);
    const residual = deltaEquity - deltaPnl;
    const tolerance = Math.max(
      config.cashflowToleranceAbs,
      config.cashflowTolerancePct * Math.max(equity, state.lastEquity as number)
    );
    if (Number.isFinite(residual) && Math.abs(residual) > tolerance) {
      detectedCashflow = residual;
      nextCumulativeNetFlow = cumulativeNetFlow + residual;
    }
  }
  const cashflowVerification: "verified" | "unverified" = attributionVerified ? "verified" : "unverified";

  // 5) HWM + Drawdown (cashflow-bereinigt, HWM nie fallend).
  const adjustedEquity = equity - nextCumulativeNetFlow;
  if (!Number.isFinite(adjustedEquity) || adjustedEquity <= 0) {
    return conservative(
      "INVALID_EQUITY",
      `cashflow-bereinigte Equity ${adjustedEquity} ist nicht positiv — konservativer Faktor`
    );
  }
  const bootstrap = state.hwm === null || !Number.isFinite(state.hwm) || state.hwm <= 0;
  const baseline = observation.baselineEquity;
  const seedHwm =
    config.bootstrapFromBaseline && baseline !== null && baseline !== undefined && Number.isFinite(baseline) && baseline > 0
      ? Math.max(baseline, adjustedEquity)
      : adjustedEquity;
  const hwm = bootstrap ? seedHwm : Math.max(state.hwm as number, adjustedEquity);
  const drawdownPct = Math.min(Math.max((hwm - adjustedEquity) / hwm, 0), 1);
  const targetFactor = drawdownTargetFactor(drawdownPct, config);
  const stage = drawdownStageFor(drawdownPct, config);
  const paused = stage === "PAUSE";

  // 6) Hysterese: sofort senken, gebounded & bestätigt heben.
  let appliedFactor = prevFactor;
  let transition: DrawdownTransition = bootstrap ? "BOOTSTRAP" : "NONE";
  let lastDegradeAt = state.lastDegradeAt;
  let lastTransitionAt = state.lastTransitionAt;
  let recoveryStreak = state.recoveryStreak >= 0 && Number.isFinite(state.recoveryStreak) ? state.recoveryStreak : 0;

  if (bootstrap) {
    // Bootstrap: die Kurve wirkt SOFORT (kein Vertrauensvorschuss). Liegt das
    // Konto bereits im Drawdown (Baseline > Equity), startet es degradiert.
    appliedFactor = targetFactor;
    transition = "BOOTSTRAP";
    lastTransitionAt = computedAt;
    recoveryStreak = 0;
    if (targetFactor < prevFactor) lastDegradeAt = computedAt;
  } else if (targetFactor < prevFactor) {
    // Degradation ist SOFORT — die sichere Richtung wartet nie.
    appliedFactor = targetFactor;
    transition = "DEGRADE";
    lastDegradeAt = computedAt;
    lastTransitionAt = computedAt;
    recoveryStreak = 0;
  } else if (targetFactor > prevFactor) {
    const cooldownOk =
      state.lastDegradeAt === null ||
      !Number.isFinite(state.lastDegradeAt) ||
      computedAt - state.lastDegradeAt >= config.recoveryCooldownMs;
    if (!cooldownOk) {
      // Der Cooldown muss ZUERST ablaufen: Erholungsbewertungen während des
      // Cooldowns zählen nicht als Bestätigung (strenger als „irgendwann
      // bestätigt“ — die Erholung ist damit garantiert mindestens so
      // konservativ wie dokumentiert, kein Flapping über die Sperre hinweg).
      recoveryStreak = 0;
    } else {
      recoveryStreak = Math.min(recoveryStreak + 1, config.recoveryConfirmations);
      if (recoveryStreak >= config.recoveryConfirmations) {
        const stepTarget = Math.min(prevFactor + config.recoveryStep, targetFactor);
        if (stepTarget > prevFactor) {
          appliedFactor = stepTarget;
          transition = "RECOVER";
          lastTransitionAt = computedAt;
        }
      }
    }
  } else {
    // Ziel = Vorstufe: kein Erholungssignal — die Bestätigungszählung startet
    // bei einer Unterbrechung neu (Recovery bleibt mindestens so konservativ
    // wie dokumentiert).
    recoveryStreak = 0;
  }

  // Boden/Deckel doppelt absichern (numerische Drift, Konfigurationsfehler).
  appliedFactor = Math.min(Math.max(appliedFactor, config.minFactor), 1);

  const reason =
    `Drawdown ${(drawdownPct * 100).toFixed(2)} % (HWM ${hwm.toFixed(2)}, cashflow-bereinigt ${adjustedEquity.toFixed(2)}` +
    `${nextCumulativeNetFlow !== 0 ? `, Netto-Cashflow ${nextCumulativeNetFlow.toFixed(2)}` : ""}` +
    `) → Stufe ${stage}, Faktor ${appliedFactor.toFixed(4)}` +
    `${paused ? " (PAUSE: keine neuen Einstiege)" : ""}` +
    `${cashflowVerification === "unverified" ? " [Cashflow-Attribution unverifiziert → keine Neutralisierung]" : ""}`;

  return {
    status: bootstrap ? "BOOTSTRAP" : "OK",
    reasonCode: bootstrap ? "BOOTSTRAP" : "OK",
    reason,
    stage,
    paused,
    equity,
    adjustedEquity,
    hwm,
    drawdownPct,
    targetFactor,
    prevFactor,
    appliedFactor,
    factorDelta: appliedFactor - prevFactor,
    transition,
    prevStage: state.stage,
    lastDegradeAt,
    recoveryStreak,
    equityAgeMs,
    reconciliationAgeMs,
    equitySource,
    cashflow: { detected: detectedCashflow, cumulative: nextCumulativeNetFlow, verification: cashflowVerification },
    policyVersion,
    nextState: {
      hwm,
      factor: appliedFactor,
      cumulativeNetFlow: nextCumulativeNetFlow,
      lastEquity: equity,
      lastObservationAt: computedAt,
      lastTradingPnl: tradingPnl,
      lastDegradeAt,
      lastTransitionAt,
      recoveryStreak,
      stage,
      policyVersion,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministische Hashing-Helfer (Policyversion, Reproduzierbarkeit, Idempotenz)
// ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 (hex) einer Zeichenkette. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Felder, die die Policy definieren. Ändert sich einer davon, ändert sich die
 * Policyversion — historische Snapshots werden dadurch NICHT uminterpretiert
 * (sie tragen ihre eigene Version).
 */
export function drawdownPolicyFingerprintFields(
  config: DrawdownScalingConfig
): Record<string, number> {
  return {
    softThresholdPct: config.softThresholdPct,
    hardThresholdPct: config.hardThresholdPct,
    minFactor: config.minFactor,
    pauseThresholdPct: config.pauseThresholdPct,
    maxEquityStalenessMs: config.maxEquityStalenessMs,
    requireReconciliation: config.requireReconciliation ? 1 : 0,
    reconciliationMaxAgeMs: config.reconciliationMaxAgeMs,
    recoveryCooldownMs: config.recoveryCooldownMs,
    recoveryConfirmations: config.recoveryConfirmations,
    recoveryStep: config.recoveryStep,
    cashflowToleranceAbs: config.cashflowToleranceAbs,
    cashflowTolerancePct: config.cashflowTolerancePct,
    bootstrapFromBaseline: config.bootstrapFromBaseline ? 1 : 0,
  };
}

/**
 * Versionierte Policy-Kennung `ddp1:<sha256>` über die Policy-Felder
 * (deterministisch, sortierte Keys). Der Betriebsmodus ist NICHT Teil der
 * Version — er ändert die Policy nicht, nur ihre Wirksamkeit.
 */
export function hashDrawdownScalingPolicy(config: DrawdownScalingConfig): string {
  return `ddp1:${sha256Hex(canonicalJsonStringify(drawdownPolicyFingerprintFields(config)))}`;
}

/**
 * Deterministischer Hash der DATEN (Equity-Beobachtung + Zeitstempel) —
 * Reproduzierbarkeit und Idempotenz-Grundlage.
 */
export function hashDrawdownScalingData(input: {
  observation: DrawdownEquityObservation;
  asOf: number;
  computedAt: number;
}): string {
  const payload = {
    equity: input.observation.equity,
    availableAt: input.observation.availableAt,
    baselineEquity: input.observation.baselineEquity ?? null,
    realized: input.observation.tradingPnl?.realized ?? null,
    unrealized: input.observation.tradingPnl?.unrealized ?? null,
    reconciliationAt: input.observation.reconciliation?.at ?? null,
    reconciliationClean: input.observation.reconciliation?.clean ?? null,
    source: input.observation.source ?? null,
    asOf: input.asOf,
    computedAt: input.computedAt,
  };
  return `dd1:${sha256Hex(canonicalJsonStringify(payload))}`;
}

/**
 * Stabiler Idempotency-Key eines Snapshots: `dsc1:<sha256>` über
 * (Minute(computedAt) | policyVersion | dataHash).
 *
 * Ein Retry oder Neustart innerhalb derselben Minute mit identischer Eingabe
 * erzeugt dieselbe ID ⇒ `ON CONFLICT DO NOTHING` ⇒ keine doppelte Zeile.
 */
export function buildDrawdownScalingIdempotencyKey(
  computedAtMs: number,
  policyVersion: string,
  dataHash: string
): string {
  const minute = Math.floor(computedAtMs / 60_000);
  return `dsc1:${sha256Hex(canonicalJsonStringify({ minute, policyVersion, dataHash }))}`;
}

/**
 * Rekonstruiert den Policy-Zustand aus einer persistierten Snapshot-Zeile
 * (DB-Roundtrip). Die Feldnamen entsprechen den Spalten von
 * `drawdown_scaling_snapshots`; die Funktion ist bewusst tolerant gegenüber
 * NUMERIC-Strings (pg-Treiber) und fehlenden optionalen Feldern.
 */
export function drawdownStateFromRow(row: {
  hwm: number | string | null;
  appliedFactor: number | string | null;
  cumulativeNetFlow: number | string | null;
  lastEquity?: number | string | null;
  lastObservationAt?: Date | string | null;
  lastTradingPnl?: number | string | null;
  lastDegradeAt?: Date | string | null;
  lastTransitionAt?: Date | string | null;
  recoveryStreak?: number | string | null;
  stage?: string | null;
  policyVersion?: string | null;
}): DrawdownScalingState {
  const numOrNull = (v: number | string | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const msOrNull = (v: Date | string | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(t) ? t : null;
  };
  const stage = row.stage === undefined || row.stage === null ? null : (row.stage as DrawdownStage);
  return {
    hwm: numOrNull(row.hwm),
    factor: numOrNull(row.appliedFactor),
    cumulativeNetFlow: numOrNull(row.cumulativeNetFlow),
    lastEquity: numOrNull(row.lastEquity),
    lastObservationAt: msOrNull(row.lastObservationAt),
    lastTradingPnl: numOrNull(row.lastTradingPnl),
    lastDegradeAt: msOrNull(row.lastDegradeAt),
    lastTransitionAt: msOrNull(row.lastTransitionAt),
    recoveryStreak: Math.max(0, Math.round(numOrNull(row.recoveryStreak) ?? 0)),
    stage: stage !== null && (DRAWDOWN_STAGES as readonly string[]).includes(stage) ? stage : null,
    policyVersion: row.policyVersion ?? null,
  };
}
