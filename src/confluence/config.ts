/**
 * Versionierte Konfiguration der Multi-Timeframe-Konfluenz (RMA-P2-03).
 *
 * Muster wie `src/scanner/config.ts`: eingebaute
 * {@link DEFAULT_CONFLUENCE_CONFIG} als Quelle der Wahrheit, optionale
 * Datei-Overrides via `CONFLUENCE_CONFIG_FILE` (validiert — eine kaputte
 * Konfiguration bricht laut ab, statt still schwächere Regeln zu aktivieren),
 * tiefe Merges nur über bekannte Schlüssel (kein Schmuggelpfad).
 *
 * Wichtig: Gewichte und Schwellen stammen AUSSCHLIESSLICH aus dieser Config.
 * Prompts dürfen sie weder setzen noch umdeuten („keine Runtime-Prompt-
 * Manipulation der Gewichte") — der technische Step übergibt den Snapshot
 * als getrennte, autoritative `trustedData`.
 */

import { readFileSync } from "node:fs";
import {
  SUPPORTED_TIMEFRAMES,
  isSupportedTimeframe,
  type SupportedTimeframe,
} from "@/lib/marketdata/historicalStore";
import {
  CONFLUENCE_CONFIG_VERSION,
  MAX_CONFLUENCE_TIMEFRAMES,
} from "./types";

/** Env-Name der optionalen Config-Datei (JSON, validiert wie Scanner). */
export const CONFLUENCE_CONFIG_FILE_ENV = "CONFLUENCE_CONFIG_FILE" as const;

/**
 * Env-Schalter der Zyklus-Integration (Rollback-/Feature-Flag-Pfad):
 * `false`/`0` ⇒ der technische Step rechnet ohne Snapshot (Legacy-Output,
 * additiv kompatibel). Default `true`. Der reine Pfad (`computeConfluence`)
 * ist vom Flag unberührt — es steuert nur die Anhängung im Step.
 */
export const CONFLUENCE_ENABLED_ENV = "CONFLUENCE_ENABLED" as const;

/** Fehler einer ungültigen Konfluenz-Konfiguration (Meldung ohne Secrets). */
export class ConfluenceConfigError extends Error {
  /** Maschinenlesbarer Code für den API-Fehler-Contract. */
  readonly code = "CONFLUENCE_CONFIG_ERROR";
  constructor(message: string) {
    super(`Konfluenz-Konfiguration ungültig: ${message}`);
    this.name = "ConfluenceConfigError";
  }
}

/** Feature-Parameter (alle bounded, alle im Artefakt nachvollziehbar). */
export interface ConfluenceFeatureConfig {
  /** Schnelle EMA-Periode (Trend). Bounds [2, 500], ganzzahlig. */
  emaFastPeriod: number;
  /** Langsame EMA-Periode (Trend). Bounds [3, 500], ganzzahlig, > fast. */
  emaSlowPeriod: number;
  /** Relativer EMA-Abstand, der Trend ±1 ergibt. Bounds (0, 1]. */
  trendScale: number;
  /** Momentum-Fenster in Bars (1..4 Fenster). Je Bounds [1, 5000]. */
  momentumLookbacks: number[];
  /** Gewichte der Momentum-Fenster (gleiche Länge, Summe 1). */
  momentumWeights: number[];
  /** Rendite, die Momentum ±1 ergibt. Bounds (0, 5]. */
  momentumScale: number;
  /** ATR-Periode (Wilder). Bounds [2, 500], ganzzahlig. */
  atrPeriod: number;
  /** ATR/Close-Anteil, der Volatilität 1 ergibt. Bounds (0, 5]. */
  volScale: number;
  /** Volatilität oberhalb: Confidence-Dämpfung (0.5 max). Bounds [0, 1). */
  volHigh: number;
  /** Gewicht der Trend-Komponente in der TF-Richtung. Bounds [0, 1]. */
  trendWeight: number;
  /** Gewicht der Momentum-Komponente in der TF-Richtung. Bounds [0, 1]. */
  momentumWeight: number;
}

/** Vollständige, versionierte Konfluenz-Konfiguration. */
export interface ConfluenceConfig {
  /** Schema-/Konfigurationsversion (erscheint in jedem Artefakt). */
  version: number;
  /** Freitext-Beschreibung. */
  description: string;
  /**
   * Konfigurierte Timeframes (1..5, eindeutig, Allowlist-geprüft).
   * Kanonische Auswertung: aufsteigend nach Periodenlänge.
   */
  timeframes: SupportedTimeframe[];
  /**
   * Gewicht je konfiguriertem Timeframe (Summe exakt 1, je [0, 1]).
   * Der Default gewichtet höhere Timeframes stärker (15m/1h/4h → .2/.3/.5).
   */
  weights: Record<string, number>;
  /** Mindest-Coverage für ein Signal. Bounds [0.1, 1], Default 0.5. */
  minCoverage: number;
  /** Konflikt oberhalb ⇒ Status DEGRADED. Bounds [0, 1], Default 0.5. */
  conflictThreshold: number;
  /** |Richtung| oberhalb ⇒ BULLISH/BEARISH statt NEUTRAL. Bounds [0, 1]. */
  biasThreshold: number;
  /**
   * Stale-Faktor: Eine Reihe ist stale, wenn `asOf − letztesBarEnde` mehr
   * als `stalePeriods` Perioden beträgt. Bounds [1, 10], Default 2.
   */
  stalePeriods: number;
  /** Maximale Bars je Timeframe im Rechenfenster. Bounds [30, 2000]. */
  maxBars: number;
  /** Feature-Parameter (bounded, s. o.). */
  features: ConfluenceFeatureConfig;
}

/**
 * Eingebaute Default-Konfiguration (Version 1).
 *
 * Drei Timeframes (15m/1h/4h, HTF-schwer), Warmup 22 Bars, Stale nach
 * 2 Perioden. Die Wahl folgt dem bisherigen Analysten-Raster (`analysts.ts`:
 * 15m/1h/4h) — deterministisch statt LLM-Sprachregelung.
 */
export const DEFAULT_CONFLUENCE_CONFIG: ConfluenceConfig = {
  version: CONFLUENCE_CONFIG_VERSION,
  description:
    "Deterministische Multi-Timeframe-Konfluenz (RMA-P2-03): as-of-ausgerichtete " +
    "Trend-/Momentum-/Volatilitätsfeatures je Timeframe, versionierte Gewichtung, " +
    "Coverage-/Conflict-Ausweis. Kein LLM, kein Netzwerk.",
  timeframes: ["15m", "1h", "4h"],
  weights: { "15m": 0.2, "1h": 0.3, "4h": 0.5 },
  minCoverage: 0.5,
  conflictThreshold: 0.5,
  biasThreshold: 0.15,
  stalePeriods: 2,
  maxBars: 300,
  features: {
    emaFastPeriod: 8,
    emaSlowPeriod: 21,
    trendScale: 0.02,
    momentumLookbacks: [3, 8, 21],
    momentumWeights: [0.2, 0.3, 0.5],
    momentumScale: 0.03,
    atrPeriod: 14,
    volScale: 0.05,
    volHigh: 0.8,
    trendWeight: 0.5,
    momentumWeight: 0.5,
  },
};

/** Toleranz, mit der Gewichtssummen geprüft werden (Gleitkomma). */
export const CONFLUENCE_WEIGHT_SUM_TOLERANCE = 1e-9;

/** Rekursive Teilstruktur — Overrides dürfen beliebig flach angegeben werden. */
export type ConfluenceDeepPartial = {
  [K in keyof ConfluenceConfig]?: ConfluenceConfig[K] extends readonly unknown[]
    ? ConfluenceConfig[K]
    : ConfluenceConfig[K] extends object
      ? Partial<ConfluenceConfig[K]>
      : ConfluenceConfig[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tiefer Merge: `patch` überschreibt `base` feldweise (Arrays ersetzen). */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue; // unbekannte Schlüssel ignoriert (kein Schmuggelpfad)
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

function num(
  value: unknown,
  path: string,
  opts: { min?: number; max?: number; int?: boolean; exclusiveMin?: boolean } = {},
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new ConfluenceConfigError(`${path}: erwartet endliche Zahl`);
  if (opts.int && !Number.isInteger(n))
    throw new ConfluenceConfigError(`${path}: erwartet Ganzzahl`);
  if (opts.min !== undefined) {
    if (opts.exclusiveMin ? n <= opts.min : n < opts.min)
      throw new ConfluenceConfigError(
        `${path}: muss ${opts.exclusiveMin ? ">" : "≥"} ${opts.min} sein`,
      );
  }
  if (opts.max !== undefined && n > opts.max)
    throw new ConfluenceConfigError(`${path}: muss ≤ ${opts.max} sein`);
  return n;
}

/**
 * Validiert eine (fremde) Konfiguration vollständig und liefert eine
 * bereinigte, tief kopierte Instanz.
 *
 * @throws {ConfluenceConfigError} bei Strukturfehlern, unplausiblen Schwellen,
 *   unbekannten/überschüssigen Timeframes oder einer Gewichtssumme ≠ 1.
 */
export function validateConfluenceConfig(raw: unknown): ConfluenceConfig {
  if (!isPlainObject(raw)) throw new ConfluenceConfigError("erwartet Objekt");
  const cfg = deepMerge(structuredClone(DEFAULT_CONFLUENCE_CONFIG), raw);

  cfg.version = num(cfg.version, "version", { min: 1, int: true });
  cfg.description = typeof cfg.description === "string" ? cfg.description.slice(0, 1000) : "";

  // ── Timeframes: 1..5, eindeutig, Allowlist ────────────────────────────────
  if (!Array.isArray(cfg.timeframes) || cfg.timeframes.length === 0) {
    throw new ConfluenceConfigError("timeframes: mindestens ein Timeframe erforderlich");
  }
  if (cfg.timeframes.length > MAX_CONFLUENCE_TIMEFRAMES) {
    throw new ConfluenceConfigError(
      `timeframes: maximal ${MAX_CONFLUENCE_TIMEFRAMES} Timeframes (waren ${cfg.timeframes.length})`,
    );
  }
  const seen = new Set<string>();
  const timeframes: SupportedTimeframe[] = [];
  for (const tf of cfg.timeframes) {
    if (!isSupportedTimeframe(tf)) {
      throw new ConfluenceConfigError(
        `timeframes: "${String(tf).slice(0, 20)}" ist keiner von ${SUPPORTED_TIMEFRAMES.join(" | ")}`,
      );
    }
    if (seen.has(tf)) throw new ConfluenceConfigError(`timeframes: "${tf}" doppelt`);
    seen.add(tf);
    timeframes.push(tf);
  }
  cfg.timeframes = timeframes;

  // ── Gewichte: je [0,1], genau die konfigurierten TFs, Summe 1 ─────────────
  if (!isPlainObject(cfg.weights)) throw new ConfluenceConfigError("weights: erwartet Objekt");
  let sum = 0;
  const weights: Record<string, number> = {};
  for (const tf of timeframes) {
    const w = num((cfg.weights as Record<string, unknown>)[tf], `weights.${tf}`, {
      min: 0,
      max: 1,
    });
    weights[tf] = w;
    sum += w;
  }
  // Überzählige Gewichte (nicht konfigurierte TFs) sind ein Fehler — sie
  // würden sonst still verfallen und die Abdeckung verfälschen.
  for (const key of Object.keys(cfg.weights)) {
    if (!seen.has(key)) {
      throw new ConfluenceConfigError(`weights.${key}: kein konfigurierter Timeframe`);
    }
  }
  if (Math.abs(sum - 1) > CONFLUENCE_WEIGHT_SUM_TOLERANCE) {
    throw new ConfluenceConfigError(`weights: Summe muss 1 sein (ist ${sum})`);
  }
  cfg.weights = weights;

  cfg.minCoverage = num(cfg.minCoverage, "minCoverage", { min: 0.1, max: 1 });
  cfg.conflictThreshold = num(cfg.conflictThreshold, "conflictThreshold", { min: 0, max: 1 });
  cfg.biasThreshold = num(cfg.biasThreshold, "biasThreshold", { min: 0, max: 1 });
  cfg.stalePeriods = num(cfg.stalePeriods, "stalePeriods", { min: 1, max: 10 });
  cfg.maxBars = num(cfg.maxBars, "maxBars", { min: 30, max: 2000, int: true });

  // ── Features (bounded) ───────────────────────────────────────────────────
  const f = cfg.features;
  if (!isPlainObject(f)) throw new ConfluenceConfigError("features: erwartet Objekt");
  f.emaFastPeriod = num(f.emaFastPeriod, "features.emaFastPeriod", { min: 2, max: 500, int: true });
  f.emaSlowPeriod = num(f.emaSlowPeriod, "features.emaSlowPeriod", { min: 3, max: 500, int: true });
  if (!(f.emaSlowPeriod > f.emaFastPeriod)) {
    throw new ConfluenceConfigError("features: emaSlowPeriod muss > emaFastPeriod sein");
  }
  f.trendScale = num(f.trendScale, "features.trendScale", { min: 0, max: 1, exclusiveMin: true });
  if (!Array.isArray(f.momentumLookbacks) || f.momentumLookbacks.length === 0) {
    throw new ConfluenceConfigError("features.momentumLookbacks: mindestens ein Fenster");
  }
  if (f.momentumLookbacks.length > 4) {
    throw new ConfluenceConfigError("features.momentumLookbacks: maximal 4 Fenster");
  }
  if (!Array.isArray(f.momentumWeights) || f.momentumWeights.length !== f.momentumLookbacks.length) {
    throw new ConfluenceConfigError(
      "features: momentumLookbacks und momentumWeights müssen gleich lang sein",
    );
  }
  f.momentumLookbacks = f.momentumLookbacks.map((v, i) =>
    num(v, `features.momentumLookbacks[${i}]`, { min: 1, max: 5000, int: true }),
  );
  const mwSum = f.momentumWeights.reduce(
    (a, v, i) => a + num(v, `features.momentumWeights[${i}]`, { min: 0 }),
    0,
  );
  if (Math.abs(mwSum - 1) > CONFLUENCE_WEIGHT_SUM_TOLERANCE) {
    throw new ConfluenceConfigError(
      `features.momentumWeights: Summe muss 1 sein (ist ${mwSum})`,
    );
  }
  f.momentumScale = num(f.momentumScale, "features.momentumScale", {
    min: 0,
    max: 5,
    exclusiveMin: true,
  });
  f.atrPeriod = num(f.atrPeriod, "features.atrPeriod", { min: 2, max: 500, int: true });
  f.volScale = num(f.volScale, "features.volScale", { min: 0, max: 5, exclusiveMin: true });
  f.volHigh = num(f.volHigh, "features.volHigh", { min: 0, max: 1 });
  if (f.volHigh >= 1) throw new ConfluenceConfigError("features.volHigh: muss < 1 sein");
  f.trendWeight = num(f.trendWeight, "features.trendWeight", { min: 0, max: 1 });
  f.momentumWeight = num(f.momentumWeight, "features.momentumWeight", { min: 0, max: 1 });
  if (Math.abs(f.trendWeight + f.momentumWeight - 1) > CONFLUENCE_WEIGHT_SUM_TOLERANCE) {
    throw new ConfluenceConfigError(
      `features: trendWeight + momentumWeight muss 1 sein (ist ${f.trendWeight + f.momentumWeight})`,
    );
  }

  // Warmup muss ins Rechenfenster passen, sonst wäre jeder Timeframe
  // strukturell `warmup`-missing (Fehlkonfiguration, laut statt still).
  const warmup = requiredWarmupBars(cfg);
  if (warmup > cfg.maxBars) {
    throw new ConfluenceConfigError(
      `features/maxBars: Warmup-Bedarf ${warmup} übersteigt maxBars ${cfg.maxBars}`,
    );
  }

  return cfg;
}

/**
 * Warmup-Bedarf in geschlossenen Bars (einzige Quelle der Warmup-Wahrheit):
 * `max(emaSlow, max(momentumLookbacks) + 1, atrPeriod + 1)`.
 * Default: max(21, 22, 15) = 22.
 */
export function requiredWarmupBars(config: ConfluenceConfig): number {
  const f = config.features;
  return Math.max(
    f.emaSlowPeriod,
    Math.max(...f.momentumLookbacks) + 1,
    f.atrPeriod + 1,
  );
}

/**
 * Baut eine Konfiguration aus den Defaults plus optionalen Overrides.
 * Praktisch für Tests und Aufrufer, die nur eine Schwelle verschieben wollen.
 */
export function resolveConfluenceConfig(overrides?: ConfluenceDeepPartial): ConfluenceConfig {
  if (!overrides) return structuredClone(DEFAULT_CONFLUENCE_CONFIG);
  return validateConfluenceConfig(overrides);
}

/**
 * Lädt die Konfiguration: Datei aus `CONFLUENCE_CONFIG_FILE`, sonst die
 * eingebauten Defaults. Eine unlesbare/ungültige Datei ist ein harter Fehler.
 */
export function loadConfluenceConfig(
  file = process.env[CONFLUENCE_CONFIG_FILE_ENV],
): ConfluenceConfig {
  if (!file) return structuredClone(DEFAULT_CONFLUENCE_CONFIG);
  return validateConfluenceConfig(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * Liest den Integrationsschalter `CONFLUENCE_ENABLED` (Default `true`).
 * Nur `false`/`0`/`off`/`no` (case-insensitiv, getrimmt) schalten ab —
 * jeder andere Wert (inkl. Tippfehler) lässt die Konfluenz an und warnt
 * bei unbekanntem Inhalt (fail-laut statt still aus).
 */
export function isConfluenceEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  warn?: (line: string) => void,
): boolean {
  const raw = env[CONFLUENCE_ENABLED_ENV];
  if (raw === undefined || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  warn?.(
    `${CONFLUENCE_ENABLED_ENV}="${raw.trim().slice(0, 20)}" ist unbekannt — Konfluenz bleibt an.`,
  );
  return true;
}
