/**
 * Pure Prioritätsbewertung und frühe Datenlage-Klassifikation (STX-05-01).
 *
 * Dieses Modul kennt nur typisierte Kandidaten und eine injizierte,
 * versionierte Config. Es liest weder Scanner-/Store-/Registry-Daten noch eine
 * Uhr. Unbekannte Pflichtmetriken bleiben Fehler; ausschließlich ein nicht
 * durchgeführter Korrelations-Zusatzlauf (`correlationPenalty: null`) wird
 * als kein Zuschlag gewertet. Das ist keine Datenlücke der Kernmetriken,
 * sondern das Fehlen einer optionalen Zusatzanalyse.
 */

import type {
  ScreeningPriorityConfig,
  ScreeningPriorityTerm,
  NumericBounds,
} from "./config";
import type { CandidateStatus, StrategyMarketCandidate } from "./types";

/** Benannter Beitrag zu einem Score; negative Werte sind Strafbeiträge. */
export type ScoreResult =
  | {
      ok: true;
      priority: number;
      contributions: Record<string, number>;
    }
  | {
      ok: false;
      errors: string[];
    };

const SCORE_TERMS = [
  "dataQuality",
  "liquidity",
  "freshness",
  "strategyFit",
  "volatilityOpportunity",
] as const satisfies readonly ScreeningPriorityTerm[];

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidBounds(bounds: NumericBounds | undefined): bounds is NumericBounds {
  return Boolean(
    bounds &&
    isUnitInterval(bounds.min) &&
    isUnitInterval(bounds.max) &&
    bounds.min <= bounds.max,
  );
}

function isWithinBounds(value: unknown, bounds: NumericBounds | undefined): value is number {
  return (
    isValidBounds(bounds) &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= bounds.min &&
    value <= bounds.max
  );
}

function configErrors(cfg: ScreeningPriorityConfig): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(cfg.version) || cfg.version < 1) {
    errors.push("config.version: muss eine positive Ganzzahl sein");
  }
  if (typeof cfg.description !== "string" || cfg.description.trim().length === 0) {
    errors.push("config.description: muss ein nicht-leerer String sein");
  }

  for (const term of SCORE_TERMS) {
    const bounds = cfg.bounds?.weights?.[term];
    if (!isValidBounds(bounds)) {
      errors.push(`config.bounds.weights.${term}: ungültige Bounds`);
    } else if (!isWithinBounds(cfg.weights?.[term], bounds)) {
      errors.push(`config.weights.${term}: außerhalb der konfigurierten Bounds`);
    }
  }

  const correlationBounds = cfg.bounds?.correlationPenaltyWeight;
  if (!isValidBounds(correlationBounds)) {
    errors.push("config.bounds.correlationPenaltyWeight: ungültige Bounds");
  } else if (!isWithinBounds(cfg.correlationPenaltyWeight, correlationBounds)) {
    errors.push("config.correlationPenaltyWeight: außerhalb der konfigurierten Bounds");
  }

  for (const threshold of ["minDataQuality", "minLiquidity"] as const) {
    const bounds = cfg.bounds?.thresholds?.[threshold];
    if (!isValidBounds(bounds)) {
      errors.push(`config.bounds.thresholds.${threshold}: ungültige Bounds`);
    } else if (!isWithinBounds(cfg.thresholds?.[threshold], bounds)) {
      errors.push(`config.thresholds.${threshold}: außerhalb der konfigurierten Bounds`);
    }
  }
  return errors;
}

/**
 * Deterministische Summe: sortiert nach Zahlenwert statt nach
 * Objekteigenschafts-Reihenfolge. Eine anders serialisierte Config kann das
 * Ergebnis dadurch nicht über eine andere Additionsreihenfolge verändern.
 */
function orderIndependentSum(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b).reduce((sum, value) => sum + value, 0);
}

function clampPriority(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Berechnet eine Priorität aus fünf Pflichtmetriken und dem optionalen
 * Korrelationszuschlag.
 *
 * Alle fünf Pflichtmetriken werden unabhängig vom Gewicht validiert: ein
 * Gewicht von 0 entfernt nur den Beitrag aus der Summe, es macht eine
 * unbekannte Metrik nicht gültig. Korrelations-`null` bedeutet dagegen
 * ausdrücklich „Zusatzanalyse nicht durchgeführt“ und zählt wie kein
 * Zuschlag (`0`); es ist kein unbekannter Kern-Score.
 */
export function scoreCandidate(
  c: StrategyMarketCandidate,
  cfg: ScreeningPriorityConfig,
): ScoreResult {
  const errors = configErrors(cfg);

  for (const field of SCORE_TERMS) {
    const value = c[field];
    if (value === null) {
      errors.push(`${field}: unbekannt (null)`);
    } else if (!isUnitInterval(value)) {
      errors.push(`${field}: muss eine endliche Zahl in [0,1] sein`);
    }
  }

  if (c.correlationPenalty !== null && !isUnitInterval(c.correlationPenalty)) {
    errors.push("correlationPenalty: muss null oder eine endliche Zahl in [0,1] sein");
  }

  if (errors.length > 0) return { ok: false, errors };

  // Die Pflichtfeld-Prüfung oben stellt sicher, dass diese Werte Zahlen sind.
  const dataQuality = c.dataQuality as number;
  const liquidity = c.liquidity as number;
  const freshness = c.freshness as number;
  const strategyFit = c.strategyFit as number;
  const volatilityOpportunity = c.volatilityOpportunity as number;
  // Begründete Asymmetrie: nur diese optionale Zusatzanalyse darf fehlen.
  const correlationPenalty = c.correlationPenalty === null ? 0 : c.correlationPenalty;

  const correlationContribution =
    correlationPenalty === 0 || cfg.correlationPenaltyWeight === 0
      ? 0
      : -(correlationPenalty * cfg.correlationPenaltyWeight);
  const contributions: Record<string, number> = {
    dataQuality: dataQuality * cfg.weights.dataQuality,
    liquidity: liquidity * cfg.weights.liquidity,
    freshness: freshness * cfg.weights.freshness,
    strategyFit: strategyFit * cfg.weights.strategyFit,
    volatilityOpportunity: volatilityOpportunity * cfg.weights.volatilityOpportunity,
    correlationPenalty: correlationContribution,
  };

  return {
    ok: true,
    priority: clampPriority(orderIndependentSum(Object.values(contributions))),
    contributions,
  };
}

/** Ergebnis für Aufrufer, die Status und Begründungen gemeinsam übernehmen. */
export type ClassifiedCandidate = StrategyMarketCandidate & {
  status: CandidateStatus;
  reasons: readonly string[];
};

function thresholdGateReason(
  field: "dataQuality" | "liquidity",
  value: number | null,
  minimum: number,
  bounds: NumericBounds | undefined,
): string | null {
  const thresholdName = field === "dataQuality" ? "minDataQuality" : "minLiquidity";
  if (!isWithinBounds(minimum, bounds)) {
    return `config.thresholds.${thresholdName}: ungültig oder außerhalb der Bounds`;
  }
  if (value === null) {
    return `${field}: unbekannt; der konfigurierte Mindestwert ${minimum} kann nicht geprüft werden`;
  }
  if (!isUnitInterval(value)) {
    return `${field}: ungültiger Wert; erwartet wird eine endliche Zahl in [0,1]`;
  }
  if (value < minimum) {
    return `${field} ${value} < konfiguriertes Minimum ${minimum}`;
  }
  return null;
}

/**
 * Klassifiziert ausschließlich die frühe Datenlage und Persistenz.
 *
 * `BLOCKED` hat Vorrang, wenn eine Schwelle unterschritten oder ihr Wert
 * unbekannt/ungültig ist. Danach folgt `DISCOVERED`, solange keine persistierte
 * Strategieversions-ID aus 04-02 belegt ist; andernfalls `READY`. Es gibt hier
 * bewusst keine Backtest-, Validierungs- oder Paper-Übergänge.
 *
 * Die Funktion mutiert `c` nicht. Sie liefert eine Kopie mit dem Status und
 * den deterministischen Gründen, weil `classifyStatus()` allein gemäß Vertrag
 * nur einen Status zurückgibt.
 */
export function classifyCandidate(
  c: StrategyMarketCandidate,
  cfg: ScreeningPriorityConfig,
): ClassifiedCandidate {
  const reasons: string[] = [];
  const dataQualityReason = thresholdGateReason(
    "dataQuality",
    c.dataQuality,
    cfg.thresholds.minDataQuality,
    cfg.bounds.thresholds.minDataQuality,
  );
  const liquidityReason = thresholdGateReason(
    "liquidity",
    c.liquidity,
    cfg.thresholds.minLiquidity,
    cfg.bounds.thresholds.minLiquidity,
  );
  if (dataQualityReason) reasons.push(dataQualityReason);
  if (liquidityReason) reasons.push(liquidityReason);

  let status: CandidateStatus;
  if (reasons.length > 0) {
    status = "BLOCKED";
  } else if (
    typeof c.strategyVersionId !== "string" ||
    c.strategyVersionId.trim().length === 0
  ) {
    status = "DISCOVERED";
    reasons.push("strategy persistence: keine Strategieversions-ID aus 04-02 nachgewiesen");
  } else {
    status = "READY";
    reasons.push(
      `dataQuality ${c.dataQuality} ≥ konfiguriertes Minimum ${cfg.thresholds.minDataQuality}`,
      `liquidity ${c.liquidity} ≥ konfiguriertes Minimum ${cfg.thresholds.minLiquidity}`,
      "strategy persistence: Strategieversion aus 04-02 nachgewiesen",
    );
  }

  return {
    ...c,
    status,
    // Vorhandene Gründe (z. B. spätere Builder-Gates) bleiben erhalten;
    // wiederholte Klassifikation erzeugt keine doppelten Gründe.
    reasons: [...new Set([...c.reasons, ...reasons])],
  };
}

/** Reine Statusprojektion der Frühklassifikation — keine Zustandsmaschine. */
export function classifyStatus(
  c: StrategyMarketCandidate,
  cfg: ScreeningPriorityConfig,
): CandidateStatus {
  return classifyCandidate(c, cfg).status;
}
