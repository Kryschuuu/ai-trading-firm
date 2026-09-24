/**
 * Trade-Journal-Konfiguration (GAP-03, v1.43.0).
 *
 * Schwellen mit Bounds + Default (Muster `src/lib/funding.ts`): jede
 * Korrektur außerhalb der Bounds ist LAUT (Warnung), nie still.
 *
 * Sicherheitsdefault: `JOURNAL_FEEDBACK_MODE=off` — nur Auswertung, keine
 * Gewichtsänderung, keine Auswirkung auf den Entscheidungspfad. Begründung:
 * Der Lern-Loop ist genau dort am gefährlichsten, wo er ohne Mindest-
 * Stichprobe und Glättung Rauschen als Signal umsetzen würde; "off" hält
 * den Entscheidungspfad byte-identisch zu v1.42.x, bis der Operator die
 * Auswertung geprüft hat (→ "monitor", dann optional "enforce").
 */
import { SUPPORTED_TIMEFRAMES, type SupportedTimeframe } from "./marketdata/historicalStore";
import { envNumber, envInt } from "./env";

/** Env-Namen (zentral, für Doku/Tests). */
export const JOURNAL_ENV = {
  FEEDBACK_MODE: "JOURNAL_FEEDBACK_MODE",
  MIN_TRADES: "JOURNAL_MIN_TRADES",
  WEIGHT_MIN: "JOURNAL_WEIGHT_MIN",
  WEIGHT_MAX: "JOURNAL_WEIGHT_MAX",
  MAX_WEIGHT_DELTA: "JOURNAL_MAX_WEIGHT_DELTA",
  CANDLES_TIMEFRAME: "JOURNAL_CANDLES_TIMEFRAME",
} as const;

/** Feedback-Modi (Allowlist — unbekannter Wert = fail-closed auf "off"). */
export const JOURNAL_FEEDBACK_MODES = ["off", "monitor", "enforce"] as const;
export type JournalFeedbackMode = (typeof JOURNAL_FEEDBACK_MODES)[number];

/** Bounds der Journal-Parameter (Clamp + Warnung). */
export const JOURNAL_BOUNDS = {
  /**
   * Mindest-Stichprobe (abgeschlossene, attributede Trades je Agent×Regime-
   * Gruppe), ab der Kennzahlen und Gewichte wirksam werden. Darunter:
   * "insufficient-sample" — NIE als Faktor. Default 100 (n ≥ 100 für
   * statistisch belastbare Trefferquote; < 20 war Münzwurf-Niveau).
   */
  minTrades: { min: 5, max: 200 },
  /**
   * Untere Gewichtsgrenze. Der Wert selbst darf nur in [0.1, 1.0] liegen —
   * darunter wäre ein Agent praktisch stummschaltet, was über ein Journal-
   * Flag kein zulässiges Instrument ist (harte Sperren leben in riskGuard).
   */
  weightMin: { min: 0.1, max: 1.0 },
  /**
   * Obere Gewichtsgrenze. Der Wert selbst darf nur in [1.0, 3.0] liegen —
   * oberhalb würde ein einzelner Agent das Hausverhalten dominieren.
   */
  weightMax: { min: 1.0, max: 3.0 },
  /**
   * Maximale Gewichtänderung JE ZYKLUS (Default 0.1): selbst bei extremen
   * Serien verschiebt sich das Gewicht schrittweise, nie per Sprung.
   */
  maxWeightDelta: { min: 0.01, max: 0.5 },
} as const;

/** Sichere Defaults (Bound-Werte = heutiges Audit-Kalkül). */
export const JOURNAL_DEFAULTS = {
  feedbackMode: "off" as JournalFeedbackMode,
  minTrades: 100,
  weightMin: 0.5,
  weightMax: 1.5,
  maxWeightDelta: 0.1,
  /** MAE/MFE-Kerzen-Intervall (Allowlist = SUPPORTED_TIMEFRAMES). */
  candlesTimeframe: "1h" as SupportedTimeframe,
} as const;

/**
 * Bayes-Prior der Trefferquoten-Glättung (Beta-Verteilung, DOKUMENTIERTE
 * KONSTANTE — bewusst nicht als Env-Flag):
 *
 *   p_geglättet = (wins + α) / (n + α + β),  α = β = 2
 *
 * α=β=2 priorisiert 50 % Trefferquote mit der Evidenzstärke von 4 Trades:
 *   - n=3, 2/3 Treffer → 4/7 ≈ 0.571 (weicht kaum vom Prior ab — Rausch-Schutz)
 *   - n=30, 20/30 Treffer → 22/34 ≈ 0.647 (empirische Quote wirkt)
 * Das entspricht einer Beta(2,2)-Prior; der Erwartungswert der Prior ist
 * 0.5 und die Varianz klein genug, dass frisch geschlossene Trades Gewichte
 * nur innerhalb der Bounds verschieben (GAP-03, D4 "Bayes-Glättung FIRST").
 */
export const JOURNAL_BETA_PRIOR = { alpha: 2, beta: 2 } as const;

/**
 * Gewichtszuordnung aus der glätteten Trefferquote (deterministisch):
 *
 *   Zielgewicht = 1.0 + (p_geglättet − 0.5) × JOURNAL_WEIGHT_SCALE
 *
 * SCALE=1.0 spannt den möglichen Prior-Mittelwert-Bereich [0, 1] exakt auf
 * die Bounds [0.5, 1.5] bei Default-Bounds; die effektive Grenze bleibt das
 * CLAMP auf [weightMin, weightMax] + das maxWeightDelta je Zyklus.
 */
export const JOURNAL_WEIGHT_SCALE = 1.0;

/**
 * Fenster für den Entscheidungsketten-Snapshot (Konstante): Agenten-Turns
 * der Mission im Zeitraum [Eröffnung − 6 h, Eröffnung] zählen als Kette.
 * Pipeline-Läufe dauern Minuten; 6 h fassen einen Lauf auf, ohne Tage alte
 * Turns mitzuziehen. Bessere Kettengenauigkeit (explizite Run-IDs) gehört
 * in die Regime-/Zyklus-Arbeit (PROMPT-06), nicht in diesen PR.
 */
export const JOURNAL_CHAIN_WINDOW_HOURS = 6;

export interface JournalConfig {
  /** off (Default) | monitor | enforce. */
  feedbackMode: JournalFeedbackMode;
  /** Mindest-Stichprobe ab der Kennzahlen/Gewichte wirksam werden. */
  minTrades: number;
  /** Untere Gewichtsgrenze (inkl.). */
  weightMin: number;
  /** Obere Gewichtsgrenze (inkl.). */
  weightMax: number;
  /** Maximale Gewichtänderung je Zyklus. */
  maxWeightDelta: number;
  /** Kerzen-Intervall für MAE/MFE (Default 1h). */
  candlesTimeframe: SupportedTimeframe;
}

/**
 * Lädt die Journal-Konfiguration aus Env (Bounds-Clamp mit Warnung,
 * Muster `loadFundingConfig`).
 */
export function loadJournalConfig(
  env: Record<string, string | undefined> = process.env
): JournalConfig {
  const rawMode = (env[JOURNAL_ENV.FEEDBACK_MODE] ?? "").trim().toLowerCase();
  let feedbackMode: JournalFeedbackMode;
  if (rawMode === "") {
    feedbackMode = JOURNAL_DEFAULTS.feedbackMode;
  } else if ((JOURNAL_FEEDBACK_MODES as readonly string[]).includes(rawMode)) {
    feedbackMode = rawMode as JournalFeedbackMode;
  } else {
    // Fail-closed: unbekannter Modus = "off" (kein partial enforce).
    console.warn(
      `[env] ${JOURNAL_ENV.FEEDBACK_MODE}="${rawMode.slice(0, 40)}" ist kein bekannter Modus ` +
        `(${JOURNAL_FEEDBACK_MODES.join(" | ")}) → sicherer Default "${JOURNAL_DEFAULTS.feedbackMode}"`
    );
    feedbackMode = JOURNAL_DEFAULTS.feedbackMode;
  }

  const rawTf = (env[JOURNAL_ENV.CANDLES_TIMEFRAME] ?? "").trim();
  let candlesTimeframe: SupportedTimeframe;
  if (rawTf === "") {
    candlesTimeframe = JOURNAL_DEFAULTS.candlesTimeframe;
  } else if ((SUPPORTED_TIMEFRAMES as readonly string[]).includes(rawTf)) {
    candlesTimeframe = rawTf as SupportedTimeframe;
  } else {
    console.warn(
      `[env] ${JOURNAL_ENV.CANDLES_TIMEFRAME}="${rawTf.slice(0, 40)}" ist kein zulässiges Timeframe ` +
        `(${SUPPORTED_TIMEFRAMES.join(" | ")}) → sicherer Default "${JOURNAL_DEFAULTS.candlesTimeframe}"`
    );
    candlesTimeframe = JOURNAL_DEFAULTS.candlesTimeframe;
  }

  return {
    feedbackMode,
    minTrades: envInt(
      JOURNAL_ENV.MIN_TRADES,
      JOURNAL_DEFAULTS.minTrades,
      JOURNAL_BOUNDS.minTrades.min,
      JOURNAL_BOUNDS.minTrades.max,
      env
    ),
    weightMin: envNumber(
      JOURNAL_ENV.WEIGHT_MIN,
      JOURNAL_DEFAULTS.weightMin,
      JOURNAL_BOUNDS.weightMin.min,
      JOURNAL_BOUNDS.weightMin.max,
      env
    ),
    weightMax: envNumber(
      JOURNAL_ENV.WEIGHT_MAX,
      JOURNAL_DEFAULTS.weightMax,
      JOURNAL_BOUNDS.weightMax.min,
      JOURNAL_BOUNDS.weightMax.max,
      env
    ),
    maxWeightDelta: envNumber(
      JOURNAL_ENV.MAX_WEIGHT_DELTA,
      JOURNAL_DEFAULTS.maxWeightDelta,
      JOURNAL_BOUNDS.maxWeightDelta.min,
      JOURNAL_BOUNDS.maxWeightDelta.max,
      env
    ),
    candlesTimeframe,
  };
}
