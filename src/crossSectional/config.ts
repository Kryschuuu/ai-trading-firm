/**
 * Versionierte Konfiguration des Cross-Sectional-Momentum-Rankings
 * (RMA-P2-04).
 *
 * Muster wie `src/scanner/config.ts` und `src/confluence/config.ts`:
 * eingebaute {@link DEFAULT_CROSS_SECTIONAL_CONFIG} als Quelle der Wahrheit,
 * optionales Datei-Override via {@link CROSS_SECTIONAL_CONFIG_FILE_ENV}
 * (validiert — eine kaputte Konfiguration bricht laut ab, statt still
 * schwächere Regeln zu aktivieren), tiefe Merges nur über bekannte Schlüssel.
 *
 * **Keine Runtime-Manipulation:** Gewichte, Horizonte und Schwellen stammen
 * ausschließlich aus dieser Config; Scanner-Prompts oder Agenten dürfen sie
 * weder setzen noch umdeuten. Eine Konfigurationsänderung erzeugt ein neues
 * `configHash` und damit eine neue Snapshot-Identität — bestehende
 * Snapshots werden nie still neu interpretiert.
 */

import { readFileSync } from "node:fs";

import {
  SUPPORTED_TIMEFRAMES,
  isSupportedTimeframe,
  type SupportedTimeframe,
} from "../lib/marketdata/historicalStore";
import { ASSET_CLASSES, type AssetClass } from "../universe/types";
import {
  AVAILABILITY_POLICIES,
  CROSS_SECTION_VALUE_MODES,
  type AvailabilityPolicy,
  type CrossSectionalConfig,
  type CrossSectionValueMode,
  type MomentumHorizonConfig,
} from "./types";
import { sha256Hex, stableStringify } from "./math";

/** Schema-Version der Snapshot-Form (DB-/Artefakt-Contract). */
export const CROSS_SECTIONAL_SCHEMA_VERSION = 1;

/** Version des Berechnungsvertrags (Code-Semantik; Teil der Provenance). */
export const CROSS_SECTIONAL_CODE_VERSION = "cross-sectional@1";

/** Schema-/Konfigurationsversion der eingebauten Default-Config. */
export const CROSS_SECTIONAL_CONFIG_VERSION = 1;

/** Env-Name der optionalen Config-Datei (JSON, validiert wie Scanner). */
export const CROSS_SECTIONAL_CONFIG_FILE_ENV = "CROSS_SECTIONAL_CONFIG_FILE";

/**
 * Env-Schalter der Scanner-Integration (Rollback-/Feature-Flag-Pfad):
 * `false`/`0` ⇒ der Scanner-Faktor meldet `unavailable` (Legacy-Output,
 * additiv kompatibel) und das CLI-Skript persistiert nicht. Default `true`.
 * Die reine Berechnung ({@link buildCrossSectionalSnapshot}) ist vom Flag
 * unberührt.
 */
export const CROSS_SECTIONAL_ENABLED_ENV = "CROSS_SECTIONAL_ENABLED";

/** Fehler einer ungültigen Cross-Sectional-Konfiguration. */
export class CrossSectionalConfigError extends Error {
  /** Maschinenlesbarer Code für den API-Fehler-Contract. */
  readonly code = "CROSS_SECTIONAL_CONFIG_ERROR";
  constructor(message: string) {
    super(`Cross-Sectional-Konfiguration ungültig: ${message}`);
    this.name = "CrossSectionalConfigError";
  }
}

/**
 * Eingebaute Default-Konfiguration (Version 1).
 *
 * Horizonte auf dem 1h-Analyse-Raster (Dokument in `docs/CROSS_SECTIONAL_RANKING.md`):
 *   - `h72`  3 Tage  (Gewicht 0.2)
 *   - `h168` 7 Tage  (Gewicht 0.3)
 *   - `h336` 14 Tage (Gewicht 0.5)
 *
 * Eligibility spiegelt die Scanner-Defaults (min. 100 000 Quote-Volumen),
 * die Mindesthistorie ist 168 geschlossene 1h-Kerzen (7 Tage), damit mit
 * zwei der drei Horizonte mindestens `minHorizonCoverage` (0.5) erreichbar
 * ist. Die Verfügbarkeitspolitik ist `ingested` (fail-closed).
 */
export const DEFAULT_CROSS_SECTIONAL_CONFIG: CrossSectionalConfig = {
  version: CROSS_SECTIONAL_CONFIG_VERSION,
  description:
    "Point-in-Time Cross-Sectional Momentum Ranking (RMA-P2-04): universumsweite, " +
    "as-of-sichere Momentum-Perzentile mit vollständiger Provenance. Kein LLM, " +
    "kein Netzwerk, keine Orders.",
  timeframe: "1h",
  availabilityPolicy: "ingested",
  horizons: [
    { id: "h72", lookback: 72, skip: 0, weight: 0.2 },
    { id: "h168", lookback: 168, skip: 0, weight: 0.3 },
    { id: "h336", lookback: 336, skip: 0, weight: 0.5 },
  ],
  valueMode: "total",
  winsorLower: 0.01,
  winsorUpper: 0.99,
  minZStd: 1e-9,
  minHorizonCoverage: 0.5,
  minVolReturns: 3,
  eligibility: {
    minVolume24h: 100_000,
    minCandles: 168,
    maxStaleBars: 2,
    assetClasses: null,
    maxUniverseSize: 500,
  },
  maxSnapshotAgeMs: 7 * 24 * 60 * 60_000,
  stabilityTopK: 10,
};

/** Prüft, ob ein Wert ein nicht-negatives endliches Number ist. */
function isNonNegativeFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CrossSectionalConfigError(`${label} muss eine nicht-negative endliche Zahl sein (ist ${JSON.stringify(value)})`);
  }
}

/** Prüft ein Integer-Feld gegen seine Bounds. */
function isIntInRange(value: unknown, label: string, min: number, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new CrossSectionalConfigError(`${label} muss eine Ganzzahl in [${min}, ${max}] sein (ist ${JSON.stringify(value)})`);
  }
}

/** Validiert EINE Horizon-Konfiguration (geschlossen gegen Typos). */
function validateHorizon(h: unknown, index: number): asserts h is MomentumHorizonConfig {
  const where = `horizons[${index}]`;
  if (!h || typeof h !== "object" || Array.isArray(h)) {
    throw new CrossSectionalConfigError(`${where} muss ein Objekt sein`);
  }
  const rec = h as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  const allowed = ["id", "lookback", "skip", "weight"];
  for (const k of keys) {
    if (!allowed.includes(k)) throw new CrossSectionalConfigError(`${where}.${k}: unbekannter Schlüssel`);
  }
  if (typeof rec.id !== "string" || !/^[a-z0-9_]{1,32}$/i.test(rec.id)) {
    throw new CrossSectionalConfigError(`${where}.id muss 1–32 Zeichen [a-z0-9_] sein`);
  }
  if (typeof rec.lookback !== "number" || !Number.isInteger(rec.lookback) || rec.lookback < 1 || rec.lookback > 100_000) {
    throw new CrossSectionalConfigError(`${where}.lookback muss eine Ganzzahl in [1, 100 000] sein`);
  }
  if (typeof rec.skip !== "number" || !Number.isInteger(rec.skip) || rec.skip < 0 || rec.skip > 100_000) {
    throw new CrossSectionalConfigError(`${where}.skip muss eine Ganzzahl in [0, 100 000] sein`);
  }
  if (typeof rec.weight !== "number" || !Number.isFinite(rec.weight) || rec.weight < 0) {
    throw new CrossSectionalConfigError(`${where}.weight muss eine endliche Zahl ≥ 0 sein`);
  }
  if (rec.lookback + rec.skip > 100_000) {
    throw new CrossSectionalConfigError(`${where}: lookback + skip überschreitet 100 000 Bars`);
  }
}

/**
 * Validiert die gesamte Konfiguration hart (fail-loud). Wurde sie geladen
 * aus einer Datei, ist `strict` implizit `true`.
 *
 * Erzwungene Invarianten (Auswahl):
 *   - Timeframe in der Store-Allowlist;
 *   - Politik/Modus in den geschlossenen Listen;
 *   - Horizonte: eindeutige IDs, lookback/skip ≥ 0, Gewichtssumme > 0;
 *   - `winsorLower < winsorUpper`, beide in [0,1];
 *   - `0 < minHorizonCoverage ≤ 1`, `minVolReturns ≥ 2`, `minZStd > 0`;
 *   - Eligibility: `minVolume24h > 0`, `minCandles ≥ 1`, `maxStaleBars ≥ 1`,
 *     `maxUniverseSize ≥ 1`, Asset-Klassen ⊆ Allowlist (oder null);
 *   - `maxSnapshotAgeMs > 0`, `2 ≤ stabilityTopK ≤ 50`.
 */
export function validateCrossSectionalConfig(config: unknown): asserts config is CrossSectionalConfig {
  const cfg = config as Partial<CrossSectionalConfig>;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new CrossSectionalConfigError("Konfiguration muss ein Objekt sein");
  }
  const keys = Object.keys(cfg).sort();
  const allowed = [
    "version",
    "description",
    "timeframe",
    "availabilityPolicy",
    "horizons",
    "valueMode",
    "winsorLower",
    "winsorUpper",
    "minZStd",
    "minHorizonCoverage",
    "minVolReturns",
    "eligibility",
    "maxSnapshotAgeMs",
    "stabilityTopK",
  ];
  for (const k of keys) {
    if (!allowed.includes(k)) throw new CrossSectionalConfigError(`unbekannter Schlüssel: ${k}`);
  }
  isIntInRange(cfg.version, "version", 1, 1_000_000);
  if (typeof cfg.description !== "string") throw new CrossSectionalConfigError("description muss ein String sein");
  if (!isSupportedTimeframe(cfg.timeframe)) {
    throw new CrossSectionalConfigError(`timeframe muss in der Allowlist liegen (${SUPPORTED_TIMEFRAMES.join(", ")})`);
  }
  if (!AVAILABILITY_POLICIES.includes(cfg.availabilityPolicy as AvailabilityPolicy)) {
    throw new CrossSectionalConfigError(`availabilityPolicy muss ${AVAILABILITY_POLICIES.join(" | ")} sein`);
  }
  if (!Array.isArray(cfg.horizons) || cfg.horizons.length === 0) {
    throw new CrossSectionalConfigError("horizons muss ein nicht-leeres Array sein");
  }
  if (cfg.horizons.length > 8) throw new CrossSectionalConfigError("maximal 8 Horizonte");
  const ids = new Set<string>();
  let weightSum = 0;
  cfg.horizons.forEach((h, i) => {
    validateHorizon(h, i);
    if (ids.has(h.id)) throw new CrossSectionalConfigError(`horizons[${i}]: doppelte ID ${h.id}`);
    ids.add(h.id);
    weightSum += h.weight;
  });
  if (weightSum <= 0) throw new CrossSectionalConfigError("Summe der Horizon-Gewichte muss > 0 sein");
  if (!CROSS_SECTION_VALUE_MODES.includes(cfg.valueMode as CrossSectionValueMode)) {
    throw new CrossSectionalConfigError(`valueMode muss ${CROSS_SECTION_VALUE_MODES.join(" | ")} sein`);
  }
  isNonNegativeFiniteNumber(cfg.winsorLower, "winsorLower");
  isNonNegativeFiniteNumber(cfg.winsorUpper, "winsorUpper");
  if (cfg.winsorLower >= cfg.winsorUpper) {
    throw new CrossSectionalConfigError("winsorLower muss kleiner als winsorUpper sein");
  }
  if (typeof cfg.minZStd !== "number" || !Number.isFinite(cfg.minZStd) || cfg.minZStd <= 0) {
    throw new CrossSectionalConfigError("minZStd muss eine endliche Zahl > 0 sein");
  }
  if (
    typeof cfg.minHorizonCoverage !== "number" ||
    !Number.isFinite(cfg.minHorizonCoverage) ||
    cfg.minHorizonCoverage <= 0 ||
    cfg.minHorizonCoverage > 1
  ) {
    throw new CrossSectionalConfigError("minHorizonCoverage muss in (0, 1] liegen");
  }
  isIntInRange(cfg.minVolReturns, "minVolReturns", 2, 100_000);
  if (typeof cfg.maxSnapshotAgeMs !== "number" || !Number.isFinite(cfg.maxSnapshotAgeMs) || cfg.maxSnapshotAgeMs <= 0) {
    throw new CrossSectionalConfigError("maxSnapshotAgeMs muss eine endliche Zahl > 0 sein");
  }
  isIntInRange(cfg.stabilityTopK, "stabilityTopK", 2, 50);

  const el = cfg.eligibility;
  if (!el || typeof el !== "object" || Array.isArray(el)) {
    throw new CrossSectionalConfigError("eligibility muss ein Objekt sein");
  }
  const elKeys = Object.keys(el).sort();
  const elAllowed = ["minVolume24h", "minCandles", "maxStaleBars", "assetClasses", "maxUniverseSize"];
  for (const k of elKeys) {
    if (!elAllowed.includes(k)) throw new CrossSectionalConfigError(`eligibility.${k}: unbekannter Schlüssel`);
  }
  if (typeof el.minVolume24h !== "number" || !Number.isFinite(el.minVolume24h) || el.minVolume24h <= 0) {
    throw new CrossSectionalConfigError("eligibility.minVolume24h muss eine Zahl > 0 sein (Quote-Volumen)");
  }
  isIntInRange(el.minCandles, "eligibility.minCandles", 1, 1_000_000);
  isIntInRange(el.maxStaleBars, "eligibility.maxStaleBars", 1, 10_000);
  isIntInRange(el.maxUniverseSize, "eligibility.maxUniverseSize", 1, 1_000_000);
  if (el.assetClasses !== null) {
    if (!Array.isArray(el.assetClasses) || el.assetClasses.length === 0) {
      throw new CrossSectionalConfigError("eligibility.assetClasses muss null oder ein nicht-leeres Array sein");
    }
    for (const ac of el.assetClasses) {
      if (!(ASSET_CLASSES as readonly string[]).includes(ac)) {
        throw new CrossSectionalConfigError(`eligibility.assetClasses: unbekannte Klasse "${String(ac)}"`);
      }
    }
  }
}

/** Lädt (und validiert) eine Config aus einer JSON-Datei (fail-loud). */
export function loadCrossSectionalConfigFromFile(file: string): CrossSectionalConfig {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new CrossSectionalConfigError(
      `Config-Datei ${file} nicht lesbar (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CrossSectionalConfigError(
      `Config-Datei ${file} ist kein gültiges JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  validateCrossSectionalConfig(parsed);
  return parsed;
}

/**
 * Lädt die gültige Konfiguration: Datei-Override (wenn Env gesetzt) mit
 * Validierung, sonst {@link DEFAULT_CROSS_SECTIONAL_CONFIG}. Der Default wird
 * nie mutiert (defensive Kopie bei Datei-Override ist implizit — die Datei
 * liefert ein frisches Objekt).
 */
export function loadCrossSectionalConfig(): CrossSectionalConfig {
  const file = process.env[CROSS_SECTIONAL_CONFIG_FILE_ENV];
  if (file && file.trim().length > 0) {
    return loadCrossSectionalConfigFromFile(file.trim());
  }
  return DEFAULT_CROSS_SECTIONAL_CONFIG;
}

/**
 * Liest den Feature-Flag-Zustand (Rollback-Pfad): `false`/`0` ⇒ aus.
 * Default `true`. Kein anderes Format schweigt zu „aus" (fail-open wäre
 * hier falsch: ein Tippfehler in der Env würde das Feature stummschalten —
 * die Doku zeigt nur die beiden erlaubten Schreibweisen).
 */
export function isCrossSectionalEnabled(): boolean {
  const raw = process.env[CROSS_SECTIONAL_ENABLED_ENV];
  if (raw === undefined || raw === "") return true;
  const v = raw.trim().toLowerCase();
  if (v === "false" || v === "0") return false;
  if (v === "true" || v === "1") return true;
  // Jedes andere Format wird wie Default behandelt und einmal laut gemeldet
  // (kein stiller Silent-Change, aber kein Crash des Scans).
  console.warn(`[cross-sectional] ${CROSS_SECTIONAL_ENABLED_ENV}="${raw}" ist kein erlaubtes Format (true|1|false|0) — es gilt true.`);
  return true;
}

/**
 * Kanonischer Config-Hash `xc1:<sha256>` über die **gesamte** Konfiguration
 * (stable JSON, sortierte Keys). Teil der Snapshot-Identität: jede
 * Konfigurationsänderung ⇒ neue Snapshot-Identität, keine Überschreibung.
 */
export function hashCrossSectionalConfig(config: CrossSectionalConfig): string {
  return `xc1:${sha256Hex(stableStringify(config))}`;
}

/** Export für Typ-Konsumenten (keine zusätzliche Implementierung). */
export type { SupportedTimeframe };
