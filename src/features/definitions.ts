/**
 * Definitionen des ersten Feature-Slices (RMA-P6-01, v1.53.0).
 *
 * **Rollout-Entscheidung (bewusst kein Big-Bang):** Der Slice beginnt mit
 * genau zwei bestehenden, deterministischen Scanner-Features (RSI, ATR) plus
 * einem abgeleiteten Enum-Feature (`scanner.atr_band`), das die
 * Dependency-Kante des Stores belegt. Bestehende Consumer (Scanner, Weekly,
 * Backtest) bleiben vollständig unberührt — der Feature Store ist ein
 * **zusätzlicher** Lesepfad, kein Umbau.
 *
 * **Einheiten und Semantik** (Teil des Definitions-Hashes, siehe `./registry.ts`):
 *
 * | Feature            | Dtype   | Einheit              | Fenster           | Wert                                  |
 * | ------------------ | ------- | -------------------- | ----------------- | ------------------------------------- |
 * | `scanner.rsi`      | number  | `index_0_100`        | `period+1` Bars   | Wilder-RSI des letzten geschlossenen Bars |
 * | `scanner.atr`      | number  | `fraction_of_close`  | `period+1` Bars   | ATR / letzter Schlusskurs (0.01 = 1 %) |
 * | `scanner.atr_band` | enum    | —                    | wie `scanner.atr` | `LOW` / `NORMAL` / `HIGH`             |
 *
 * Die Parameter (`period`, Bandgrenzen) spiegeln die Scanner-Defaults aus
 * `src/scanner/config.ts`. `tests/featureStore.test.ts` erzwingt die
 * Deckungsgleichheit — driften die Scanner-Defaults ab, wird das ein
 * Testfehler und **nicht** ein stiller Semantikwechsel im Store. Eine
 * abweichende Konfiguration (z. B. `period = 21`) ergibt einen anderen
 * `configHash` und damit eine andere Definitionsversion — nicht eine
 * Umschreibung bestehender Werte.
 */
import { DEFAULT_ANALYSIS_TIMEFRAME } from "../lib/marketdata/historicalStore";
import { DEFAULT_SCANNER_CONFIG } from "../scanner/config";
import { FEATURE_EXECUTORS } from "./compute";
import { FeatureRegistry } from "./registry";
import type { FeatureDefinitionInput } from "./types";

/** Stabile Kennung der Slice-Features (Schema `namespace.name`). */
export const FEATURE_IDS = {
  rsi: "scanner.rsi",
  atr: "scanner.atr",
  atrBand: "scanner.atr_band",
} as const;

/** Owner der Slice-Features (Betriebsübergabe: wer die Semantik verantwortet). */
export const FEATURE_OWNER = "scanner";

/**
 * Konfiguration des Slices. Defaults **sind** die Scanner-Defaults; jeder
 * Aufrufer darf eine andere Konfiguration übergeben — die Semantikversion
 * folgt dann aus dem Config-Hash.
 */
export interface FeatureSliceConfig {
  rsiPeriod: number;
  atrPeriod: number;
  /** Untere Bandgrenze (ATR-Anteil am Kurs): darunter `LOW`. */
  atrBandLow: number;
  /** Obere Bandgrenze: ab hier `HIGH` (Grenze gehört zur oberen Klasse). */
  atrBandHigh: number;
}

/** Default-Konfiguration des Slices (Deckungsgleichheit mit dem Scanner getestet). */
export const FEATURE_SLICE_DEFAULTS: FeatureSliceConfig = Object.freeze({
  rsiPeriod: DEFAULT_SCANNER_CONFIG.factors.rsi.period,
  atrPeriod: DEFAULT_SCANNER_CONFIG.factors.atr.period,
  atrBandLow: DEFAULT_SCANNER_CONFIG.factors.atr.idealLowPct,
  atrBandHigh: DEFAULT_SCANNER_CONFIG.factors.atr.idealHighPct,
});

/**
 * Deklariert die Slice-Definitionen für eine gegebene Konfiguration.
 *
 * Rein und deterministisch: gleiche Konfiguration ⇒ gleiche
 * Definitions-Fingerprints (eine geänderte Konfiguration ⇒ neue Version).
 */
export function sliceDefinitions(config: FeatureSliceConfig = FEATURE_SLICE_DEFAULTS): readonly FeatureDefinitionInput[] {
  const atrVersion = 1;
  return [
    {
      featureId: FEATURE_IDS.rsi,
      version: 1,
      label: "RSI (Wilder, Diagnose)",
      description:
        "Relative Strength Index nach Wilder über den letzten geschlossenen Bars. " +
        "Rohwert 0..100 (kein normalisierter Score); ohne Verlusttage 100, bei " +
        "völlig flacher Reihe 50. Identische Formel wie Scanner-Faktor `rsi`.",
      dtype: "number",
      enumValues: null,
      unit: "index_0_100",
      valueDecimals: 4,
      entityType: "instrument",
      timeframe: DEFAULT_ANALYSIS_TIMEFRAME,
      lookbackBars: config.rsiPeriod + 1,
      dependencies: [],
      computeKey: "scanner.rsi@1",
      config: { period: config.rsiPeriod },
      owner: FEATURE_OWNER,
    },
    {
      featureId: FEATURE_IDS.atr,
      version: 1,
      label: "ATR als Kursanteil (Wilder)",
      description:
        "Average True Range (Wilder-Glättung) geteilt durch den letzten " +
        "Schlusskurs des Fensters. Einheit: Dezimalanteil (0.01 = 1 % des " +
        "Kurses); identische Formel wie Scanner-Faktor `atr`.",
      dtype: "number",
      enumValues: null,
      unit: "fraction_of_close",
      valueDecimals: 6,
      entityType: "instrument",
      timeframe: DEFAULT_ANALYSIS_TIMEFRAME,
      lookbackBars: config.atrPeriod + 1,
      dependencies: [],
      computeKey: "scanner.atr@1",
      config: { period: config.atrPeriod },
      owner: FEATURE_OWNER,
    },
    {
      featureId: FEATURE_IDS.atrBand,
      version: 1,
      label: "ATR-Band (abgeleitet)",
      description:
        "Bandklassifikation des ATR-Kursanteils: `LOW` unterhalb der unteren " +
        "Grenze, `HIGH` ab der oberen Grenze, sonst `NORMAL`. Grenzen gehören " +
        "zur oberen Klasse (konsistent zu `classifyRegime`). Abhängigkeit: " +
        `scanner.atr@${atrVersion} derselben Eventzeit; fehlt der ` +
        "Abhängigkeitswert, ist das Band unbekannt (kein geratener Wert).",
      dtype: "enum",
      enumValues: ["LOW", "NORMAL", "HIGH"],
      unit: null,
      valueDecimals: null,
      entityType: "instrument",
      timeframe: DEFAULT_ANALYSIS_TIMEFRAME,
      lookbackBars: config.atrPeriod + 1,
      dependencies: [{ featureId: FEATURE_IDS.atr, version: atrVersion }],
      computeKey: "scanner.atr_band@1",
      config: { period: config.atrPeriod, lowThreshold: config.atrBandLow, highThreshold: config.atrBandHigh },
      owner: FEATURE_OWNER,
    },
  ];
}

/**
 * Registry des Produktions-Slices (Default-Konfiguration, alle Executors).
 *
 * @throws {FeatureStoreError} bei ungültigen Definitionen, toten
 *   Executor-Verweisen, fehlenden Abhängigkeiten oder Zyklen — der Prozess
 *   startet mit einer kaputten Registry bewusst nicht.
 */
export function createSliceRegistry(config: FeatureSliceConfig = FEATURE_SLICE_DEFAULTS): FeatureRegistry {
  return FeatureRegistry.create(sliceDefinitions(config), FEATURE_EXECUTORS);
}

/** Prozessweite Registry des Produktions-Slices (lazy, stabil über HMR). */
let sliceRegistry: FeatureRegistry | null = null;

export function getSliceRegistry(): FeatureRegistry {
  sliceRegistry ??= createSliceRegistry();
  return sliceRegistry;
}
