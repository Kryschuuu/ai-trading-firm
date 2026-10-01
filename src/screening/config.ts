/**
 * Versionierte, kalibrierbare Prioritätskonfiguration (STX-05-01).
 *
 * Die Defaultwerte und ihre Bounds liegen gemeinsam in
 * `screening.config.json`; eine optionale externe Datei kann über
 * `SCREENING_PRIORITY_CONFIG_FILE` geladen werden. Overrides werden nur für
 * bekannte Felder angenommen und fail-loud gegen die Bounds validiert.
 * `scoreCandidate()` selbst bekommt die bereits aufgelöste Config injiziert
 * und führt keinerlei IO aus.
 *
 * Begründung der Startgewichte: Datenqualität zuerst, weil ein Backtest auf
 * unvollständigen Daten keine Aussage hat; Liquidität an zweiter Stelle, weil
 * sie bestimmt, ob der spätere Live-Einstieg überhaupt möglich ist (Spread
 * frisst die Edge). Die Werte sind **Startwerte**, keine Optima — die
 * Kalibrierung gegen echte Screening-Läufe ist ein späterer Vorgang.
 */

import { readFileSync } from "node:fs";
import screeningConfigJson from "./screening.config.json";

/** Score-Terme in stabiler, dokumentierter Reihenfolge. */
export const SCREENING_PRIORITY_TERMS = [
  "dataQuality",
  "liquidity",
  "freshness",
  "strategyFit",
  "volatilityOpportunity",
] as const;

export type ScreeningPriorityTerm = (typeof SCREENING_PRIORITY_TERMS)[number];

export interface NumericBounds {
  readonly min: number;
  readonly max: number;
}

export interface ScreeningPriorityBounds {
  readonly weights: Readonly<Record<ScreeningPriorityTerm, NumericBounds>>;
  readonly correlationPenaltyWeight: NumericBounds;
  readonly thresholds: Readonly<{
    minDataQuality: NumericBounds;
    minLiquidity: NumericBounds;
  }>;
}

/** Vollständige, versionierte Config; sie ist zugleich der Typ für cfg-Parameter. */
export interface ScreeningPriorityConfig {
  readonly version: number;
  readonly description: string;
  readonly weights: Readonly<Record<ScreeningPriorityTerm, number>>;
  readonly correlationPenaltyWeight: number;
  readonly thresholds: Readonly<{
    minDataQuality: number;
    minLiquidity: number;
  }>;
  /** Bounds sind Bestandteil des versionierten Config-Artefakts. */
  readonly bounds: ScreeningPriorityBounds;
}

/** Env-Name einer optionalen, zur Laufzeit eingelesenen JSON-Konfiguration. */
export const SCREENING_PRIORITY_CONFIG_FILE_ENV = "SCREENING_PRIORITY_CONFIG_FILE";

/** Fehler einer ungültigen Screening-Prioritätskonfiguration. */
export class ScreeningPriorityConfigError extends Error {
  readonly code = "SCREENING_PRIORITY_CONFIG_ERROR";

  constructor(message: string) {
    super(`Screening-Prioritätskonfiguration ungültig: ${message}`);
    this.name = "ScreeningPriorityConfigError";
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

const importedConfig: ScreeningPriorityConfig = screeningConfigJson;

/**
 * Versionierte Defaults samt Bounds (Quelle: `screening.config.json`).
 *
 * Die fünf positiven gewichteten Beiträge summieren sich im Default zu 1. Die
 * `correlationPenaltyWeight` ist 1, weil die Ausgangsformel den
 * Korrelationszuschlag unskaliert abzieht. Schwellen für Datenqualität und
 * Liquidität sind ebenfalls in der Datei versioniert und können dort bzw. in
 * einem externen Config-Override angepasst werden.
 */
export const SCREENING_PRIORITY_CONFIG: ScreeningPriorityConfig = deepFreeze(importedConfig);

/** Alias mit explizitem Namen für Aufrufer, die den Default injizieren. */
export const DEFAULT_SCREENING_PRIORITY_CONFIG: ScreeningPriorityConfig =
  SCREENING_PRIORITY_CONFIG;

const TOP_LEVEL_KEYS = [
  "version",
  "description",
  "weights",
  "correlationPenaltyWeight",
  "thresholds",
  "bounds",
] as const;
const THRESHOLD_KEYS = ["minDataQuality", "minLiquidity"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ScreeningPriorityConfigError(`${label} muss ein Objekt sein`);
  }
  return value;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ScreeningPriorityConfigError(`${label}.${key}: unbekannter Schlüssel`);
    }
  }
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readBounds(
  raw: unknown,
  fallback: NumericBounds,
  label: string,
): NumericBounds {
  if (raw === undefined) return fallback;
  const record = asRecord(raw, label);
  assertKnownKeys(record, ["min", "max"], label);
  const min = record.min === undefined ? fallback.min : record.min;
  const max = record.max === undefined ? fallback.max : record.max;
  if (!isUnitInterval(min) || !isUnitInterval(max) || min > max) {
    throw new ScreeningPriorityConfigError(`${label} muss gültige Bounds in [0,1] mit min ≤ max enthalten`);
  }
  return Object.freeze({ min, max });
}

function readBoundsTree(raw: unknown): ScreeningPriorityBounds {
  if (raw === undefined) return SCREENING_PRIORITY_CONFIG.bounds;
  const record = asRecord(raw, "bounds");
  assertKnownKeys(record, ["weights", "correlationPenaltyWeight", "thresholds"], "bounds");

  const rawWeights = record.weights === undefined
    ? {}
    : asRecord(record.weights, "bounds.weights");
  assertKnownKeys(rawWeights, SCREENING_PRIORITY_TERMS, "bounds.weights");
  const weights = Object.fromEntries(
    SCREENING_PRIORITY_TERMS.map((term) => [
      term,
      readBounds(
        rawWeights[term],
        SCREENING_PRIORITY_CONFIG.bounds.weights[term],
        `bounds.weights.${term}`,
      ),
    ]),
  ) as Record<ScreeningPriorityTerm, NumericBounds>;

  const rawThresholds = record.thresholds === undefined
    ? {}
    : asRecord(record.thresholds, "bounds.thresholds");
  assertKnownKeys(rawThresholds, THRESHOLD_KEYS, "bounds.thresholds");
  const thresholds = {
    minDataQuality: readBounds(
      rawThresholds.minDataQuality,
      SCREENING_PRIORITY_CONFIG.bounds.thresholds.minDataQuality,
      "bounds.thresholds.minDataQuality",
    ),
    minLiquidity: readBounds(
      rawThresholds.minLiquidity,
      SCREENING_PRIORITY_CONFIG.bounds.thresholds.minLiquidity,
      "bounds.thresholds.minLiquidity",
    ),
  };

  return deepFreeze({
    weights,
    correlationPenaltyWeight: readBounds(
      record.correlationPenaltyWeight,
      SCREENING_PRIORITY_CONFIG.bounds.correlationPenaltyWeight,
      "bounds.correlationPenaltyWeight",
    ),
    thresholds,
  });
}

function readBoundedValue(value: unknown, bounds: NumericBounds, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    throw new ScreeningPriorityConfigError(
      `${label} muss eine endliche Zahl in [${bounds.min}, ${bounds.max}] sein`,
    );
  }
  return value;
}

/**
 * Mergt einen partiellen, bekannten Config-Override über die versionierten
 * Defaults. Falsche Typen, unbekannte Keys und Werte außerhalb der Bounds
 * werden abgewiesen statt still geklemmt.
 */
export function resolveScreeningPriorityConfig(
  overrides: unknown = {},
): ScreeningPriorityConfig {
  const record = asRecord(overrides, "Konfiguration");
  assertKnownKeys(record, TOP_LEVEL_KEYS, "Konfiguration");

  const version = record.version === undefined
    ? SCREENING_PRIORITY_CONFIG.version
    : record.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 1_000_000) {
    throw new ScreeningPriorityConfigError("version muss eine Ganzzahl in [1, 1 000 000] sein");
  }

  const description = record.description === undefined
    ? SCREENING_PRIORITY_CONFIG.description
    : record.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new ScreeningPriorityConfigError("description muss ein nicht-leerer String sein");
  }

  const bounds = readBoundsTree(record.bounds);
  const rawWeights = record.weights === undefined
    ? {}
    : asRecord(record.weights, "weights");
  assertKnownKeys(rawWeights, SCREENING_PRIORITY_TERMS, "weights");
  const weights = Object.fromEntries(
    SCREENING_PRIORITY_TERMS.map((term) => [
      term,
      readBoundedValue(
        rawWeights[term] === undefined
          ? SCREENING_PRIORITY_CONFIG.weights[term]
          : rawWeights[term],
        bounds.weights[term],
        `weights.${term}`,
      ),
    ]),
  ) as Record<ScreeningPriorityTerm, number>;

  const rawThresholds = record.thresholds === undefined
    ? {}
    : asRecord(record.thresholds, "thresholds");
  assertKnownKeys(rawThresholds, THRESHOLD_KEYS, "thresholds");
  const thresholds = {
    minDataQuality: readBoundedValue(
      rawThresholds.minDataQuality === undefined
        ? SCREENING_PRIORITY_CONFIG.thresholds.minDataQuality
        : rawThresholds.minDataQuality,
      bounds.thresholds.minDataQuality,
      "thresholds.minDataQuality",
    ),
    minLiquidity: readBoundedValue(
      rawThresholds.minLiquidity === undefined
        ? SCREENING_PRIORITY_CONFIG.thresholds.minLiquidity
        : rawThresholds.minLiquidity,
      bounds.thresholds.minLiquidity,
      "thresholds.minLiquidity",
    ),
  };
  const correlationPenaltyWeight = readBoundedValue(
    record.correlationPenaltyWeight === undefined
      ? SCREENING_PRIORITY_CONFIG.correlationPenaltyWeight
      : record.correlationPenaltyWeight,
    bounds.correlationPenaltyWeight,
    "correlationPenaltyWeight",
  );

  return deepFreeze({
    version,
    description: description.trim(),
    weights,
    correlationPenaltyWeight,
    thresholds,
    bounds,
  });
}

/**
 * Lädt die Default-Config oder eine versionierte JSON-Datei. IO bleibt in
 * diesem Konfigurationsadapter; die Scoring-Funktionen bleiben pure und
 * erhalten das Ergebnis als Argument.
 */
export function loadScreeningPriorityConfig(
  filePath: string | undefined = process.env[SCREENING_PRIORITY_CONFIG_FILE_ENV],
): ScreeningPriorityConfig {
  const selectedPath = filePath?.trim();
  if (!selectedPath) return DEFAULT_SCREENING_PRIORITY_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(selectedPath, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unbekannter Fehler";
    throw new ScreeningPriorityConfigError(`Config-Datei konnte nicht gelesen/geparst werden (${detail})`);
  }
  return resolveScreeningPriorityConfig(raw);
}
