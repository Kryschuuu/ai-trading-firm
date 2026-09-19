/**
 * Plausibilitäts-Schicht über Agenten-Outputs (GAP-08, v1.49.0).
 *
 * Die Schema-Validierung (`src/cycle/schemas.ts`) prüft die STRUKTUR einer
 * LLM-Antwort (Typen, Enums, Pflichtfelder). Diese Schicht läuft danach und
 * prüft die INHALTLICHE Plausibilität gegen bekannte Referenzdaten — valide
 * Struktur ist Voraussetzung, aber kein Freibrief:
 *
 *   (a) MONOTONICITY      — LONG: stopLoss < entry < takeProfit (SHORT gespiegelt)
 *   (b) PRICE_RANGE       — entry/stop/tp innerhalb ± Band um den letzten
 *                           Known-Good-Kurs (jüngster valider Close der Kerzen)
 *   (c) RATIONALE_MISSING — sehr hohe Confidence (≥ 0.9) ohne ausreichende
 *                           Begründung (kürzer als PLAUSIBILITY_MIN_RATIONALE_CHARS)
 *   (d) HALLUCINATED_PRICE — im Begründungstext genannte Kurse außerhalb
 *                           [minLow, maxHigh] der Kerzen (regex-Heuristik)
 *
 * Fail-closed: Befunde führen — nach genau EINEM Retry mit Fehlermeldungs-
 * Kontext — zum deterministischen Skip (leerer Fallback + Audit
 * `CYCLE_STEP_SKIPPED` mit Grund `plausibility:CODE` + sichtbarer Status im
 * Step-Output). Es wird niemals still mit unplausiblen Werten weitergerechnet.
 *
 * Grenzen der Heuristik (d), dokumentiert statt verschwiegen:
 *   - Jede Zahl im Text wird als Kurskandidat gewertet. Kennzahlen ohne
 *     Kursbezug (RSI-Werte, Prozentangaben ohne %-Zeichen, Stückzahlen)
 *     können Fehlbefunde erzeugen — Begründungen sollten Kurse als einzige
 *     nackte Zahlen nennen.
 *   - Ausgenommen sind: Zahlen mit folgendem `%` (Prozent), vierstellige
 *     Jahreszahlen (1900–2100) und Zahlen in enger Wortbindung.
 *   - Tausendertrennzeichen werden nur im en-Format (`65,000.5`) erkannt;
 *     de-Dezimalkommas (`65,5`) sind mehrdeutig und werden NICHT als eine
 *     Zahl gelesen (JSON-Prompts nutzen ohnehin Punkt-Dezimale).
 *   - Die Heuristik läuft nur, wenn Kerzen mit Hoch/Tief vorliegen; ohne
 *     Referenzdaten melden die Regeln (b) und (d) `referenceMissing` statt
 *     zu raten — sichtbar, aber nicht blockierend.
 *
 * Repo-Stil: handgeschriebene Validatoren, keine Schema-Library (wie
 * `src/cycle/schemas.ts`). Reine Funktionen — offline unit-testbar.
 */

import { envNumber } from "@/lib/env";
import type { MacroStepOutput, ResearchStepOutput } from "./schemas";

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration (Flags mit Bounds + Default, siehe .env.example + CONFIGURATION.md)
// ─────────────────────────────────────────────────────────────────────────────

/** Preisband um den Known-Good-Kurs in Prozent (Bounds [1, 90]). */
export const PLAUSIBILITY_PRICE_BAND_PCT_DEFAULT = 15;
export const PLAUSIBILITY_PRICE_BAND_PCT_MIN = 1;
export const PLAUSIBILITY_PRICE_BAND_PCT_MAX = 90;

/**
 * Mindestlänge der Begründung bei sehr hoher Confidence, in Zeichen
 * (Bounds [0, 1000]; 0 = Regel (c) deaktiviert).
 */
export const PLAUSIBILITY_MIN_RATIONALE_CHARS_DEFAULT = 40;
export const PLAUSIBILITY_MIN_RATIONALE_CHARS_MIN = 0;
export const PLAUSIBILITY_MIN_RATIONALE_CHARS_MAX = 1000;

/** Ab dieser Confidence gilt ein Output als „sehr sicher“ (Regel (c)). */
export const HIGH_CONFIDENCE_THRESHOLD = 0.9;

export interface PlausibilityConfig {
  priceBandPct: number;
  minRationaleChars: number;
}

export function loadPlausibilityConfig(
  env: Record<string, string | undefined> = process.env,
): PlausibilityConfig {
  // `envNumber` (GAP-02-Muster): ungesetzt/leer → Default; ungültig oder
  // außerhalb der Bounds → Default/Clamp MIT Warnung (fail-laut, nie still).
  // Beide Flags sind ganzzahlig (`Math.trunc` nach dem lauten Clamp).
  return {
    priceBandPct: Math.trunc(
      envNumber(
        "PLAUSIBILITY_PRICE_BAND_PCT",
        PLAUSIBILITY_PRICE_BAND_PCT_DEFAULT,
        PLAUSIBILITY_PRICE_BAND_PCT_MIN,
        PLAUSIBILITY_PRICE_BAND_PCT_MAX,
        env,
      ),
    ),
    minRationaleChars: Math.trunc(
      envNumber(
        "PLAUSIBILITY_MIN_RATIONALE_CHARS",
        PLAUSIBILITY_MIN_RATIONALE_CHARS_DEFAULT,
        PLAUSIBILITY_MIN_RATIONALE_CHARS_MIN,
        PLAUSIBILITY_MIN_RATIONALE_CHARS_MAX,
        env,
      ),
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Typen
// ─────────────────────────────────────────────────────────────────────────────

export type PlausibilityCode =
  | "PRICE_RANGE"
  | "MONOTONICITY"
  | "RATIONALE_MISSING"
  | "HALLUCINATED_PRICE";

export const PLAUSIBILITY_CODES: readonly PlausibilityCode[] = [
  "PRICE_RANGE",
  "MONOTONICITY",
  "RATIONALE_MISSING",
  "HALLUCINATED_PRICE",
];

export function isPlausibilityCode(value: unknown): value is PlausibilityCode {
  return (
    typeof value === "string" &&
    (PLAUSIBILITY_CODES as readonly string[]).includes(value)
  );
}

/** Strukturierter Befund: Code + betroffenes Feld + begrenzte Detailzeile. */
export interface PlausibilityFinding {
  code: PlausibilityCode;
  /** Feldpfad, z. B. `setups[0].stopLoss` oder `thesis`. */
  field: string;
  detail: string;
}

/** Minimale Kerzenform — bewusst strukturell (HistoricalStore-kompatibel). */
export interface PlausibilityCandle {
  close: number;
  high?: number;
  low?: number;
}

/**
 * Einheitliche Entscheidungssicht für Setup-/Entscheidungs-Outputs.
 * Adapter (`researchSetupsToDecisions`, `macroToDecision`) überführen die
 * validierten Step-Outputs in diese Form; Regeln, deren Eingaben fehlen
 * (z. B. keine Preise bei Makro), melden sich als „nicht anwendbar“.
 */
export interface PlausibleDecision {
  instrumentId?: string;
  side?: "LONG" | "SHORT";
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  /** Confidence in [0, 1] (bei Research: 1 − riskScore). */
  confidence?: number;
  /** Begründungstext (bei Research: thesis, bei Makro: thesis). */
  rationale?: string;
}

export type PlausibilityStatus = "OK" | "RETRIED" | "SKIPPED";

/**
 * Ergebnis EINER Plausibilitäts-Prüfung (Agenten-Port): Nach genau einem
 * Retry ist entweder alles plausibel (OK/RETRIED) oder der Step wird
 * geskippt (SKIPPED + Befunde des letzten Versuchs).
 */
export interface PlausibilityOutcome {
  status: PlausibilityStatus;
  /** Befunde des letzten Versuchs (leer außer bei SKIPPED). */
  findings: PlausibilityFinding[];
  /** 1 (erster Versuch plausibel) oder 2 (genau ein Retry). */
  attempts: number;
  /** Nur bei SKIPPED: Warum wurde geskippt? */
  skipReason?: "plausibility" | "invalid-retry";
  /** Instrumente mit Preisen, aber ohne verwertbare Kerzen (sichtbar, nicht blockierend). */
  referenceMissingInstruments: string[];
}

/** Sichtbarer Status-Block im Step-Output/Artefakt (fail-closed sichtbar). */
export interface PlausibilityStepStatus {
  status: PlausibilityStatus;
  findings: PlausibilityFinding[];
  attempts: number;
  referenceMissing: string[];
}

/** Spezifikation der Plausibilitäts-Prüfung für EINEN Agenten-Aufruf. */
export interface PlausibilitySpec {
  /** Bildet den validierten Step-Output auf Entscheidungen ab. */
  adapt: (output: unknown) => PlausibleDecision[];
  /** Kerzen für alle Entscheidungen (Single-Instrument-Fall, z. B. Eval). */
  candles?: readonly PlausibilityCandle[];
  /** Kerzen je Instrument (Mehr-Instrument-Fall, z. B. Research-Step). */
  candlesByInstrument?: Readonly<Record<string, readonly PlausibilityCandle[]>>;
  /** Feldpräfix für Befunde, z. B. `setups` → `setups[0].entryPrice`. */
  fieldPrefix?: string;
  /** Schwellen-Override (Tests/Eval); Default: Env-Konfiguration. */
  config?: Partial<PlausibilityConfig>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helfer
// ─────────────────────────────────────────────────────────────────────────────

function finitePrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function boundDetail(text: string, max = 200): string {
  const clean = String(text).replace(/[\r\n\t]+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Jüngster valider Schlusskurs (Known-Good-Kurs) oder null. */
export function lastKnownGoodClose(
  candles: readonly PlausibilityCandle[] | undefined,
): number | null {
  if (!candles) return null;
  for (let i = candles.length - 1; i >= 0; i--) {
    const close = finitePrice(candles[i]?.close);
    if (close !== null) return close;
  }
  return null;
}

/** [minLow, maxHigh] über alle Kerzen mit finitem Hoch/Tief oder null. */
export function candlePriceRange(
  candles: readonly PlausibilityCandle[] | undefined,
): { minLow: number; maxHigh: number } | null {
  if (!candles || candles.length === 0) return null;
  let minLow = Number.POSITIVE_INFINITY;
  let maxHigh = Number.NEGATIVE_INFINITY;
  for (const c of candles) {
    const low = finitePrice(c?.low);
    const high = finitePrice(c?.high);
    if (low === null || high === null) continue;
    if (low < minLow) minLow = low;
    if (high > maxHigh) maxHigh = high;
  }
  if (!Number.isFinite(minLow) || !Number.isFinite(maxHigh)) return null;
  return { minLow, maxHigh };
}

// ─────────────────────────────────────────────────────────────────────────────
// Regeln (a)–(d)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regel (a): Monotonie je Richtung — LONG: stop < entry < tp (strikt);
 * SHORT gespiegelt. Ohne vollständige Preise/Richtung nicht anwendbar.
 */
export function checkMonotonicity(
  decision: PlausibleDecision,
  fieldPrefix: string,
): PlausibilityFinding[] {
  const entry = finitePrice(decision.entryPrice);
  const stop = finitePrice(decision.stopLoss);
  const tp = finitePrice(decision.takeProfit);
  if (entry === null || stop === null || tp === null) return [];
  if (decision.side === "LONG") {
    if (stop < entry && entry < tp) return [];
    const violated = stop >= entry ? "stopLoss" : "takeProfit";
    return [
      {
        code: "MONOTONICITY",
        field: `${fieldPrefix}.${violated}`,
        detail: boundDetail(
          `LONG verlangt stopLoss < entry < takeProfit, erhalten stop=${stop} entry=${entry} tp=${tp}.`,
        ),
      },
    ];
  }
  if (decision.side === "SHORT") {
    if (tp < entry && entry < stop) return [];
    const violated = stop <= entry ? "stopLoss" : "takeProfit";
    return [
      {
        code: "MONOTONICITY",
        field: `${fieldPrefix}.${violated}`,
        detail: boundDetail(
          `SHORT verlangt takeProfit < entry < stopLoss, erhalten stop=${stop} entry=${entry} tp=${tp}.`,
        ),
      },
    ];
  }
  return [];
}

/**
 * Regel (b): Preisnähe — entry/stop/tp müssen innerhalb ± Band um den
 * letzten Known-Good-Kurs liegen. Fängt Kurs-Halluzinationen (Modell erfindet
 * ein Preisniveau, das es nicht gibt). Bandgrenzen sind INKLUSIVE.
 */
export function checkPriceBand(
  decision: PlausibleDecision,
  candles: readonly PlausibilityCandle[] | undefined,
  bandPct: number,
  fieldPrefix: string,
): { findings: PlausibilityFinding[]; referenceMissing: boolean } {
  const prices: Array<[string, number | null]> = [
    ["entryPrice", finitePrice(decision.entryPrice)],
    ["stopLoss", finitePrice(decision.stopLoss)],
    ["takeProfit", finitePrice(decision.takeProfit)],
  ];
  if (prices.every(([, p]) => p === null)) {
    return { findings: [], referenceMissing: false }; // keine Preise → nicht anwendbar
  }
  const reference = lastKnownGoodClose(candles);
  if (reference === null) {
    return { findings: [], referenceMissing: true }; // Preise da, Referenz fehlt → sichtbar melden
  }
  // Relativer Vergleich (skalenfrei, FP-stabil): Die Bandkante selbst
  // (`rel === band`, z. B. exakt ±15 %) ist INKLUSIVE — erst darüber liegt
  // ein Befund vor. Das Epsilon schluckt reine Darstellungsfehler.
  const band = Math.min(90, Math.max(1, bandPct)) / 100;
  const lo = reference * (1 - band);
  const hi = reference * (1 + band);
  const findings: PlausibilityFinding[] = [];
  for (const [name, price] of prices) {
    if (price === null) continue;
    const rel = Math.abs(price - reference) / reference;
    if (rel - band > 1e-9) {
      findings.push({
        code: "PRICE_RANGE",
        field: `${fieldPrefix}.${name}`,
        detail: boundDetail(
          `${name}=${price} liegt außerhalb ±${bandPct} % um den Known-Good-Kurs ${reference} (Band [${lo.toFixed(4)}, ${hi.toFixed(4)}]).`,
        ),
      });
    }
  }
  return { findings, referenceMissing: false };
}

/**
 * Regel (c): Confidence-Konsistenz — sehr hohe Confidence (≥ 0.9) verlangt
 * eine Begründung von mindestens `minChars` Zeichen. `minChars = 0`
 * deaktiviert die Regel. Außerhalb [0, 1] ist bereits Schema-Sache.
 */
export function checkConfidenceRationale(
  decision: PlausibleDecision,
  minChars: number,
  fieldPrefix: string,
  rationaleField = "rationale",
): PlausibilityFinding[] {
  if (minChars <= 0) return [];
  const confidence = decision.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return [];
  if (confidence < HIGH_CONFIDENCE_THRESHOLD) return [];
  const length = (decision.rationale ?? "").trim().length;
  if (length >= minChars) return [];
  return [
    {
      code: "RATIONALE_MISSING",
      field: `${fieldPrefix}.${rationaleField}`,
      detail: boundDetail(
        `Confidence ${confidence} ≥ ${HIGH_CONFIDENCE_THRESHOLD} verlangt eine Begründung ≥ ${minChars} Zeichen, erhalten ${length}.`,
      ),
    },
  ];
}

/**
 * Extrahiert Kurskandidaten aus Freitext (en-Format, inkl. Tausendertrenn-
 * zeichen). Übersprungen werden: Prozentangaben (`70 %`), Jahreszahlen
 * (1900–2100) und Zahlen in enger Wortbindung (`v2`, `BTC3x`).
 */
export function extractPriceCandidates(text: string): number[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const out: number[] = [];
  const re =
    /(?<![\w.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])-?\d+(?:\.\d+)?(?![\w])/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    const after = text.slice(match.index + raw.length);
    if (/^\s*%/.test(after)) continue; // Prozentangabe, kein Kurs
    const normalized = raw.replace(/,/g, "");
    const value = Number(normalized);
    if (!Number.isFinite(value) || value <= 0) continue;
    // Jahreszahl (1900–2100, ganzzahlig, ohne Dezimalpunkt): kein Kurs.
    if (
      !normalized.includes(".") &&
      Number.isInteger(value) &&
      value >= 1900 &&
      value <= 2100
    ) {
      continue;
    }
    out.push(value);
  }
  return out;
}

/**
 * Regel (d): Zahlenbezug — genannte Kurse im Begründungstext müssen
 * innerhalb [minLow, maxHigh] der Kerzen liegen. Heuristik mit dokumentierten
 * Grenzen (siehe Modul-Doku): nackte Kennzahlen ohne Kursbezug können
 * Fehlbefunde erzeugen.
 */
export function checkHallucinatedPrices(
  decision: PlausibleDecision,
  candles: readonly PlausibilityCandle[] | undefined,
  fieldPrefix: string,
  rationaleField = "rationale",
): { findings: PlausibilityFinding[]; referenceMissing: boolean } {
  const rationale = decision.rationale;
  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    return { findings: [], referenceMissing: false };
  }
  const candidates = extractPriceCandidates(rationale);
  if (candidates.length === 0) {
    return { findings: [], referenceMissing: false };
  }
  const range = candlePriceRange(candles);
  if (range === null) {
    return { findings: [], referenceMissing: true };
  }
  const findings: PlausibilityFinding[] = [];
  for (const price of candidates) {
    if (price < range.minLow || price > range.maxHigh) {
      findings.push({
        code: "HALLUCINATED_PRICE",
        field: `${fieldPrefix}.${rationaleField}`,
        detail: boundDetail(
          `Genannter Kurs ${price} liegt außerhalb [${range.minLow}, ${range.maxHigh}] der Referenzkerzen.`,
        ),
      });
    }
  }
  return { findings, referenceMissing: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline: eine Entscheidung / eine Spec
// ─────────────────────────────────────────────────────────────────────────────

export interface DecisionCheckResult {
  findings: PlausibilityFinding[];
  referenceMissing: boolean;
}

/**
 * Prüft EINE Entscheidung mit allen vier Regeln (valide Struktur wird
 * vorausgesetzt — diese Schicht läuft NACH der Schema-Validierung).
 * Regel-Reihenfolge ist fix (deterministische Befund-Reihenfolge).
 */
export function checkDecisionPlausibility(
  decision: PlausibleDecision,
  candles: readonly PlausibilityCandle[] | undefined,
  config: PlausibilityConfig,
  fieldPrefix: string,
  rationaleField = "rationale",
): DecisionCheckResult {
  const findings: PlausibilityFinding[] = [
    ...checkMonotonicity(decision, fieldPrefix),
  ];
  const band = checkPriceBand(decision, candles, config.priceBandPct, fieldPrefix);
  findings.push(...band.findings);
  findings.push(
    ...checkConfidenceRationale(decision, config.minRationaleChars, fieldPrefix, rationaleField),
  );
  const hallucinated = checkHallucinatedPrices(
    decision,
    candles,
    fieldPrefix,
    rationaleField,
  );
  findings.push(...hallucinated.findings);
  return {
    findings,
    referenceMissing: band.referenceMissing || hallucinated.referenceMissing,
  };
}

export interface PlausibilityCheckResult {
  findings: PlausibilityFinding[];
  /** Sortierte Instrumente mit Preisen, aber ohne verwertbare Kerzen. */
  referenceMissingInstruments: string[];
}

/**
 * Führt eine Plausibilitäts-Spec aus: adaptiert den validierten Output,
 * wählt je Entscheidung die Kerzen (je Instrument, sonst gemeinsam) und
 * sammelt Befunde in deterministischer Reihenfolge.
 */
export function runPlausibilitySpec(
  output: unknown,
  spec: PlausibilitySpec,
  env: Record<string, string | undefined> = process.env,
): PlausibilityCheckResult {
  const base = loadPlausibilityConfig(env);
  const config: PlausibilityConfig = {
    priceBandPct: spec.config?.priceBandPct ?? base.priceBandPct,
    minRationaleChars: spec.config?.minRationaleChars ?? base.minRationaleChars,
  };
  const decisions = spec.adapt(output);
  const prefix = spec.fieldPrefix ?? "output";
  const findings: PlausibilityFinding[] = [];
  const referenceMissing = new Set<string>();
  decisions.forEach((decision, index) => {
    const instrumentId = decision.instrumentId;
    const candles =
      (instrumentId !== undefined
        ? spec.candlesByInstrument?.[instrumentId]
        : undefined) ?? spec.candles;
    const fieldPrefix = decisions.length > 1 ? `${prefix}[${index}]` : prefix;
    const result = checkDecisionPlausibility(
      decision,
      candles,
      config,
      fieldPrefix,
      "thesis",
    );
    findings.push(...result.findings);
    if (result.referenceMissing) {
      referenceMissing.add(instrumentId ?? `#${index}`);
    }
  });
  return {
    findings,
    referenceMissingInstruments: [...referenceMissing].sort(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter: validierte Step-Outputs → Entscheidungen
// ─────────────────────────────────────────────────────────────────────────────

/** Research-Setups: Confidence = 1 − riskScore, Begründung = thesis. */
export function researchSetupsToDecisions(
  output: ResearchStepOutput,
): PlausibleDecision[] {
  if (!output || !Array.isArray(output.setups)) return [];
  return output.setups.map((setup) => ({
    instrumentId: setup.instrumentId,
    side: setup.side,
    entryPrice: setup.entryPrice,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    confidence:
      typeof setup.riskScore === "number" && Number.isFinite(setup.riskScore)
        ? Math.min(1, Math.max(0, 1 - setup.riskScore))
        : undefined,
    rationale: setup.thesis,
  }));
}

/** Makro-Output: Confidence + thesis (preisbezogene Regeln entfallen). */
export function macroToDecision(output: MacroStepOutput): PlausibleDecision {
  return {
    confidence: output.confidence,
    rationale: output.thesis,
  };
}

/** Adapter für AgentInvocationSpec (Research): wirft nie, toleriert Fremdform. */
export function adaptResearchOutput(output: unknown): PlausibleDecision[] {
  return researchSetupsToDecisions(output as ResearchStepOutput);
}

/** Adapter für AgentInvocationSpec (Makro): wirft nie, toleriert Fremdform. */
export function adaptMacroOutput(output: unknown): PlausibleDecision[] {
  if (!output || typeof output !== "object") return [];
  return [macroToDecision(output as MacroStepOutput)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry-Feedback, Audit-Grund, Artefakt-Status
// ─────────────────────────────────────────────────────────────────────────────

/** Eindeutige, sortierte Codes eines Befund-Satzes (deterministisch). */
export function findingCodes(findings: readonly PlausibilityFinding[]): PlausibilityCode[] {
  return [...new Set(findings.map((f) => f.code))].sort();
}

/**
 * Fehlermeldungs-Kontext für den genau EINEN Retry: listet die Befunde des
 * ersten Versuchs (begrenzt) und verlangt korrigiertes JSON — keine Prosa.
 */
export function formatPlausibilityFeedback(
  findings: readonly PlausibilityFinding[],
  maxFindings = 8,
): string {
  const lines = findings.slice(0, Math.max(1, maxFindings)).map(
    (f) => `- [${f.code}] ${f.field}: ${f.detail}`,
  );
  const hidden = findings.length - lines.length;
  return [
    "=== PLAUSIBILITY FEEDBACK (previous output rejected, exactly 1 retry left) ===",
    "The previous JSON was schema-valid but implausible. Fix ALL findings:",
    ...lines,
    ...(hidden > 0 ? [`- … +${hidden} weitere Befunde gleichen Musters`] : []),
    "Respond again with strictly valid JSON only. Do not explain; output JSON only.",
    "=== END PLAUSIBILITY FEEDBACK ===",
  ].join("\n");
}

/** Audit-Grund im audit_log, z. B. `plausibility:MONOTONICITY,PRICE_RANGE`. */
export function plausibilityAuditReason(outcome: {
  findings: readonly PlausibilityFinding[];
  skipReason?: PlausibilityOutcome["skipReason"];
}): string {
  if (outcome.skipReason === "invalid-retry") return "plausibility:invalid-retry";
  const codes = findingCodes(outcome.findings);
  return codes.length > 0 ? `plausibility:${codes.join(",")}` : "plausibility:unknown";
}

/** Sichtbarer Status-Block für Step-Output/Artefakt (kopiert, begrenzt). */
export function toStepStatus(outcome: PlausibilityOutcome): PlausibilityStepStatus {
  return {
    status: outcome.status,
    findings: outcome.findings.map((f) => ({
      code: f.code,
      field: f.field.slice(0, 120),
      detail: f.detail.slice(0, 200),
    })),
    attempts: outcome.attempts,
    referenceMissing: [...outcome.referenceMissingInstruments],
  };
}
