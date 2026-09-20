/**
 * Forecast-Capture — Policy `fp1` (RMA-P3-01, v1.55.0).
 *
 * Bildet strukturierte Analysten-Ausgaben (view/confidence) zum
 * Aufnahmezeitpunkt auf unveränderliche Forecast-Verträge ab.
 *
 * ── Was erfasst wird (und was bewusst nicht) ────────────────────────────────
 * Nur Rollen mit eindeutigem Ziel-Entity und definiertem Horizont
 * (`FORECAST_ROLE_HORIZONS`): TECHNICAL_ANALYST (4h), SWING_RESEARCHER,
 * SCOUT, DILIGENCE (je 72h). Marktweite Analysen ohne Ziel-Entity
 * (MACRO_ANALYST, NEWS_ANALYST) werden NICHT erfasst — ein Forecast ohne
 * Ziel-Event wäre keine messbare Aussage. Es werden niemals Forecasts
 * rückwirkend aus Freitext rekonstruiert.
 *
 * ── Wahrscheinlichkeitsabbildung (Policy `fp1`) ─────────────────────────────
 *   sign(view) = +1 BULLISH | −1 BEARISH | 0 NEUTRAL
 *   p_up = clamp(0.5 + sign · confidence / 2, 0.01, 0.99)
 *
 * Damit ist confidence = 0 stets der uninformierte Forecast (0.5) und
 * confidence = 1 nie eine absolute Sicherheit (Clip verhindert unendlichen
 * Log Loss und Brier-Maximalstrafen für einzelne Fehlprognosen bleiben
 * begrenzt). Der Vektor `[1 − p_up, p_up]` über `["DOWN","UP"]` summiert
 * exakt zu 1; die Validierung fordert das für jeden Vertrag.
 *
 * ── Zeitsemantik ────────────────────────────────────────────────────────────
 *   reference_time = floor(as_of / tf) · tf   (Schlusszeit der letzten vor
 *                                              `as_of` geschlossenen Kerze;
 *                                              liegt `as_of` exakt auf dem
 *                                              Raster, zählt der soeben
 *                                              geschlossene Bar.)
 *   resolves_at    = reference_time + horizon
 *   availability_deadline = resolves_at + FORECAST_SETTLE_GRACE_MS
 * Alle Zeiten liegen auf dem Kerzenraster des Auflösungs-Timeframes.
 *
 * ── Fail-closed ─────────────────────────────────────────────────────────────
 * Jeder Grund, der keinen gültigen Vertrag zulässt, liefert `null` plus
 * einen geschlossenen Reason-Code — niemals einen halb gültigen Forecast
 * und niemals einen still verworfenen Fehler.
 */

import {
  FORECAST_CAPTURE_ROLES,
  FORECAST_CATEGORIES,
  FORECAST_CONTRACT_VERSION,
  FORECAST_HORIZONS,
  FORECAST_LIMITS,
  FORECAST_RESOLUTION_POLICY_VERSION,
  FORECAST_ROLE_HORIZONS,
  FORECAST_TARGET_CATEGORY,
  FORECAST_TARGET_KIND,
  FORECAST_TIMEFRAME,
  FORECAST_TIMEFRAME_MS,
  FORECAST_SETTLE_GRACE_MS,
  isForecastHorizonId,
  type ForecastCaptureRole,
  type ForecastCategory,
  type ForecastContract,
  type ForecastHorizonId,
} from "./types";

/** Geschlossene Gründe, warum eine Analyse keinen Forecast erzeugt. */
export const FORECAST_CAPTURE_REASONS = [
  /** Rolle ist per Policy nicht forecast-fähig (kein Ziel-Entity/Horizont). */
  "ROLE_NOT_FORECASTABLE",
  /** Kein gültiges Ziel-Symbol (z. B. `MARKT`, leer, Freitext). */
  "NO_ENTITY",
  /** View ist keine der drei definierten Sichten. */
  "INVALID_VIEW",
  /** Confidence fehlt oder ist nicht endlich. */
  "INVALID_CONFIDENCE",
  /** Referenzkurs nicht ermittelbar (keine geschlossene Kerze). */
  "NO_REFERENCE_DATA",
  /** Instrument konnte keiner kanonischen Entity zugeordnet werden. */
  "UNRESOLVED_INSTRUMENT",
  /** Vertragsvalidierung fehlgeschlagen (z. B. Vektorsumme ≠ 1). */
  "INVALID_CONTRACT",
] as const;
export type ForecastCaptureSkipReason = (typeof FORECAST_CAPTURE_REASONS)[number];

export type ForecastCaptureResult =
  | { ok: true; contract: ForecastContract }
  | { ok: false; reason: ForecastCaptureSkipReason };

/** Signum der Sicht (Policy `fp1`). */
export function viewSign(view: string): 1 | -1 | 0 | null {
  const v = typeof view === "string" ? view.toUpperCase() : "";
  if (v === "BULLISH") return 1;
  if (v === "BEARISH") return -1;
  if (v === "NEUTRAL") return 0;
  return null;
}

/** Wahrscheinlichkeitsabbildung der Policy `fp1` (inkl. Clip). */
export function probabilityFromView(view: string, confidence: number): number | null {
  const sign = viewSign(view);
  if (sign === null) return null;
  if (!Number.isFinite(confidence)) return null;
  const c = Math.min(1, Math.max(0, confidence));
  const raw = 0.5 + (sign * c) / 2;
  return Math.min(FORECAST_LIMITS.probabilityClipMax, Math.max(FORECAST_LIMITS.probabilityClipMin, raw));
}

/**
 * Validiert einen kategorialen Wahrscheinlichkeitsvektor fail-closed:
 * Länge 2..maxCategories, alle Werte endlich in [0,1], Summe = 1 ± Toleranz.
 */
export function validateProbabilityVector(
  probabilities: readonly unknown[],
  tolerance: number = FORECAST_LIMITS.probabilitySumTolerance
): probabilities is readonly number[] {
  if (!Array.isArray(probabilities)) return false;
  if (probabilities.length < 2 || probabilities.length > FORECAST_LIMITS.maxCategories) return false;
  let sum = 0;
  for (const p of probabilities) {
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return false;
    sum += p;
  }
  return Math.abs(sum - 1) <= tolerance;
}

/** Prüft ein Analysten-Symbol auf Erfassbarkeit (geschlossen, kein Freitext). */
export function isForecastableSymbol(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const symbol = value.trim().toUpperCase();
  if (symbol.length === 0 || symbol.length > 24) return false;
  // Platzhalter-/Sammelbegriffe des Hauses sind keine Instrumente.
  if (symbol === "MARKT" || symbol === "MARKET" || symbol === "NONE" || symbol === "NULL") return false;
  return /^[A-Z0-9][A-Z0-9._=^-]{0,23}$/.test(symbol);
}

export interface ForecastCaptureInput {
  /** Rolle des Analysten. */
  role: string;
  /** Ziel-Symbol laut Analyse-Metadaten (kann fehlen/ungültig sein). */
  symbol: unknown;
  /** Sicht (`BULLISH` | `BEARISH` | `NEUTRAL`). */
  view: unknown;
  /** Konfidenz des Analysten, 0..1. */
  confidence: unknown;
  /** Entstehungszeit (Analysezeitpunkt). */
  asOf: Date;
  /**
   * Schlusskurs der letzten vor `asOf` geschlossenen Kerze des
   * Auflösungs-Timeframes — `null`, wenn keine geschlossene Kerze
   * ermittelbar war (fail-closed ⇒ kein Forecast).
   */
  referenceClose: number | null;
  /** Schlusszeit dieser Kerze — `null` wie oben. */
  referenceTime: Date | null;
  /** Kanonische Instrument-ID des Ziel-Entity (z. B. `PAPER:BTC`). */
  entityId: string | null;
  /** Prompt-Version des Agenten zum Aufnahmezeitpunkt. */
  promptVersion: number;
  /** Modelltag zum Aufnahmezeitpunkt. */
  model: string;
  /** Adaptives Regime zum Aufnahmezeitpunkt (`UNKNOWN` zulässig). */
  regime: string;
}

/**
 * Bildet eine Analysten-Ausgabe auf einen Forecast-Vertrag ab (rein).
 *
 * Die Funktion ist total: jeder ungültige Eingang liefert einen geschlossenen
 * Skip-Grund statt eines partiellen Vertrags.
 */
export function forecastFromAnalysis(input: ForecastCaptureInput): ForecastCaptureResult {
  const role = typeof input.role === "string" ? input.role : "";
  if (!(FORECAST_CAPTURE_ROLES as readonly string[]).includes(role)) {
    return { ok: false, reason: "ROLE_NOT_FORECASTABLE" };
  }
  const captureRole = role as ForecastCaptureRole;

  if (!isForecastableSymbol(input.symbol)) return { ok: false, reason: "NO_ENTITY" };
  const symbol = String(input.symbol).trim().toUpperCase();

  const view = typeof input.view === "string" ? input.view.toUpperCase() : "";
  if (viewSign(view) === null) return { ok: false, reason: "INVALID_VIEW" };

  const confidence = typeof input.confidence === "number" ? input.confidence : NaN;
  if (!Number.isFinite(confidence)) return { ok: false, reason: "INVALID_CONFIDENCE" };

  if (!Number.isInteger(input.promptVersion) || input.promptVersion < 0) {
    return { ok: false, reason: "INVALID_CONTRACT" };
  }
  if (typeof input.model !== "string" || input.model.length === 0 || input.model.length > 128) {
    return { ok: false, reason: "INVALID_CONTRACT" };
  }

  if (
    typeof input.referenceClose !== "number" ||
    !Number.isFinite(input.referenceClose) ||
    input.referenceClose <= 0 ||
    input.referenceTime === null
  ) {
    return { ok: false, reason: "NO_REFERENCE_DATA" };
  }

  if (typeof input.entityId !== "string" || input.entityId.trim().length === 0 || input.entityId.length > 64) {
    return { ok: false, reason: "UNRESOLVED_INSTRUMENT" };
  }

  const horizonId: ForecastHorizonId = FORECAST_ROLE_HORIZONS[captureRole];
  if (!isForecastHorizonId(horizonId)) return { ok: false, reason: "INVALID_CONTRACT" };

  const pUp = probabilityFromView(view, confidence);
  if (pUp === null) return { ok: false, reason: "INVALID_VIEW" };
  const probabilities = [Number((1 - pUp).toFixed(9)), Number(pUp.toFixed(9))];
  if (!validateProbabilityVector(probabilities)) return { ok: false, reason: "INVALID_CONTRACT" };

  const referenceMs = input.referenceTime.getTime();
  if (!Number.isInteger(referenceMs) || referenceMs <= 0) return { ok: false, reason: "NO_REFERENCE_DATA" };
  // Rasterprüfung: Referenz- und Auflösungszeit müssen auf dem Timeframe-Raster liegen.
  if (referenceMs % FORECAST_TIMEFRAME_MS !== 0) return { ok: false, reason: "INVALID_CONTRACT" };

  const asOfMs = input.asOf.getTime();
  if (!Number.isInteger(asOfMs) || asOfMs <= 0 || referenceMs > asOfMs) {
    return { ok: false, reason: "INVALID_CONTRACT" };
  }

  const horizonMs = FORECAST_HORIZONS[horizonId] * 60_000;
  const resolvesMs = referenceMs + horizonMs;
  const contract: ForecastContract = {
    agentRole: captureRole,
    promptVersion: input.promptVersion,
    model: input.model,
    entityType: "instrument",
    entityId: input.entityId.trim(),
    symbol,
    targetKind: FORECAST_TARGET_KIND,
    categories: FORECAST_CATEGORIES,
    probabilities,
    targetCategory: FORECAST_TARGET_CATEGORY,
    horizonId,
    timeframe: FORECAST_TIMEFRAME,
    asOf: new Date(asOfMs),
    referenceTime: new Date(referenceMs),
    referenceClose: input.referenceClose,
    resolvesAt: new Date(resolvesMs),
    availabilityDeadline: new Date(resolvesMs + FORECAST_SETTLE_GRACE_MS),
    regime: typeof input.regime === "string" && input.regime.length > 0 ? input.regime.slice(0, 32) : "UNKNOWN",
    policyVersion: FORECAST_RESOLUTION_POLICY_VERSION,
    contractVersion: FORECAST_CONTRACT_VERSION,
  };

  return { ok: true, contract };
}

/**
 * Rundet eine Epochenzeit AB auf das Raster des Auflösungs-Timeframes und
 * liefert die Schlusszeit der letzten zu diesem Zeitpunkt geschlossenen Kerze.
 *
 * Liegt `asOf` exakt auf dem Raster, ist die gerade geschlossene Kerze die
 * Referenz (ihre Schlusszeit == `asOf`). Sonst ist es das Raster davor.
 * (Die Kerzen-Startzeit des Referenzbars ist `reference − timeframe`.)
 */
export function referenceTimeOf(asOfMs: number, timeframeMs: number = FORECAST_TIMEFRAME_MS): number {
  if (!Number.isInteger(asOfMs) || asOfMs <= 0) {
    throw new Error(`referenceTimeOf: ungültige Zeit ${String(asOfMs)}.`);
  }
  if (!Number.isInteger(timeframeMs) || timeframeMs <= 0) {
    throw new Error(`referenceTimeOf: ungültiger Timeframe ${String(timeframeMs)}.`);
  }
  return Math.floor(asOfMs / timeframeMs) * timeframeMs;
}
