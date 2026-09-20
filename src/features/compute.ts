/**
 * Berechnung von Featurewerten (RMA-P6-01, v1.53.0) — **rein und deterministisch**.
 *
 * Dieses Modul ist die einzige Stelle, an der Featurewerte entstehen. Es gibt
 * keine Uhr (`Date.now()`), kein IO, keine Zufallsquelle und keine
 * Umgebungsvariablen: alles, was eine Berechnung braucht, kommt als Argument.
 * Ein Test kann damit jeden Wert exakt nachrechnen.
 *
 * ── Zeitsemantik (Look-ahead-Schutz) ────────────────────────────────────────
 * Ein Fenster enthält nur **abgeschlossene** Kerzen: `bar.time + timeframe ≤ asOf`.
 * Die Eventzeit eines Werts ist die **Schlusszeit** der letzten Kerze. Die
 * Verfügbarkeit wird aus Eventzeit und Ingestion-Zeitstempel abgeleitet
 * (`availableAtOf`) — nie aus dem Berechnungszeitpunkt.
 *
 * ── Wiederverwendung statt Zweitformel ─────────────────────────────────────
 * `scanner.rsi` nutzt `computeRsi` aus `src/scanner/factors/rsi.ts`,
 * `scanner.atr` nutzt `computeAtrPct` aus `src/scanner/factors/atr.ts`. Die
 * Featurewerte sind damit per Konstruktion identisch zu den Scanner-Faktoren;
 * `tests/featureStore.test.ts` prüft das zusätzlich gegen die Faktoren selbst.
 */
import { createHash } from "node:crypto";

import { stableStringify } from "../lib/ruleEngine";
import { SUPPORTED_TIMEFRAME_MS, type SupportedTimeframe } from "../lib/marketdata/historicalStore";
import { computeAtrPct } from "../scanner/factors/atr";
import { computeRsi } from "../scanner/factors/rsi";
import { roundTo } from "../scanner/math";
import {
  FEATURE_QUALITY_STATUSES,
  FeatureStoreError,
  type FeatureQualityStatus,
} from "./types";
import type { FeatureComputeContext, FeatureComputeOutcome, FeatureExecutorTable } from "./registry";
import type { FeatureDefinition } from "./types";

/**
 * Rohkerze, wie der Planer sie erwartet — Alias auf
 * {@link import("./registry").FeatureBarSource}, damit Consumer/Docs eine
 * sprechende Bezeichnung nutzen können, ohne dass ein zweiter Typ entsteht.
 */
export type FeatureBarInput = import("./registry").FeatureBarSource;

/** Schweregrad der Qualitätszustände (höher = schwerer). */
export const FEATURE_QUALITY_SEVERITY: Readonly<Record<FeatureQualityStatus, number>> = Object.freeze({
  OK: 0,
  UNKNOWN: 1,
  CROSSCHECK: 2,
  GAP: 3,
  OUTLIER: 4,
  DUPLICATE: 5,
  INVALID: 6,
});

/** Übersetzt eine Klasse des Quality-Layers in einen Feature-Status. */
export function mapQualityClass(cls: string): FeatureQualityStatus {
  return (FEATURE_QUALITY_STATUSES as readonly string[]).includes(cls) ? (cls as FeatureQualityStatus) : "UNKNOWN";
}

/**
 * Qualitätsstatus eines Fensters: der **schwerste** Befund gewinnt.
 *
 * `UNKNOWN` (kein Befund vorhanden) ist bewusst schwerer als `OK`: ein Gate,
 * das geprüfte Daten verlangt, muss `UNKNOWN` fail-closed behandeln. Ein leeres
 * Fenster ohne Befund ist `OK` — es gab nichts zu beanstanden.
 */
export function windowQualityStatus(statuses: readonly FeatureQualityStatus[]): FeatureQualityStatus {
  let worst: FeatureQualityStatus = "OK";
  for (const status of statuses) {
    if (FEATURE_QUALITY_SEVERITY[status] > FEATURE_QUALITY_SEVERITY[worst]) worst = status;
  }
  return worst;
}

/** Schlusszeit (= Eventzeit) einer Kerze in ms. */
export function barCloseTime(bar: { time: number }, timeframe: SupportedTimeframe): number {
  return bar.time + SUPPORTED_TIMEFRAME_MS[timeframe];
}

/**
 * Filtert **abgeschlossene** Kerzen bis `asOf` (aufsteigend nach Schlusszeit,
 * deterministischer Tie-Break über `time` und Ursprungsindex).
 *
 * Eine Kerze, deren Schlusszeit nach `asOf` liegt, ist nicht enthalten: aus
 * einem unvollständigen Bar darf kein Feature berechnet werden.
 */
export function closedBarsAt<T extends { time: number }>(
  bars: readonly T[],
  asOf: number,
  timeframe: SupportedTimeframe
): readonly T[] {
  const ms = SUPPORTED_TIMEFRAME_MS[timeframe];
  if (!Number.isFinite(asOf) || !Number.isFinite(ms)) return [];
  return bars
    .filter((bar) => Number.isFinite(bar.time) && bar.time + ms <= asOf)
    .map((bar, index) => ({ bar, index }))
    .sort((a, b) => a.bar.time - b.bar.time || a.index - b.index)
    .map((entry) => entry.bar);
}

/**
 * Jüngster Ingestion-Zeitstempel eines Fensters (ms).
 *
 * Fail-closed: ein unbrauchbarer `fetchedAt` ist **kein** Grund, eine Kerze als
 * „schon immer bekannt“ zu behandeln — die Materialisierung bricht mit
 * `FEATURE_INPUT_INVALID` ab. Der Historical Store schreibt `fetchedAt` immer.
 */
export function maxIngestedAtMs(window: readonly { fetchedAt: string }[]): number {
  let max = Number.NaN;
  for (const bar of window) {
    const ms = Date.parse(bar.fetchedAt);
    if (!Number.isFinite(ms)) {
      throw new FeatureStoreError(
        "FEATURE_INPUT_INVALID",
        `Kerze mit unbrauchbarem Ingestion-Zeitstempel "${String(bar.fetchedAt).slice(0, 32)}" — Verfügbarkeit nicht bestimmbar.`,
        { fetchedAt: String(bar.fetchedAt).slice(0, 64) }
      );
    }
    if (!Number.isFinite(max) || ms > max) max = ms;
  }
  return max;
}

/**
 * Verfügbarkeitszeitpunkt eines Werts in ms.
 *
 *   * `bar_close` — die Kerze gilt mit ihrem Schluss als bekannt
 *     (Forschungsannahme eines vollständigen, replay-sauberen Datensatzes).
 *   * `ingested`  — die Kerze gilt erst ab dem jüngsten Ingestion-Zeitstempel
 *     des Fensters als bekannt (`max(eventTime, maxIngestedAt)`, nie kleiner als
 *     die Eventzeit).
 */
export function availableAtOf(args: {
  eventTimeMs: number;
  maxIngestedAtMs: number;
  policy: "bar_close" | "ingested";
}): number {
  if (args.policy === "bar_close") return args.eventTimeMs;
  if (!Number.isFinite(args.maxIngestedAtMs)) return args.eventTimeMs;
  return Math.max(args.eventTimeMs, args.maxIngestedAtMs);
}

/** Liest einen Zahlenparameter der Definition — ohne stillen Default. */
export function numberParam(definition: FeatureDefinition, key: string): number {
  const value = definition.config[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FeatureStoreError(
      "FEATURE_DEFINITION_INVALID",
      `Definition ${definition.featureId}@${definition.version} hat keinen endlichen Zahlenparameter "${key}".`,
      { featureId: definition.featureId, version: definition.version, key }
    );
  }
  return value;
}

/**
 * `ds1:<sha256>` — Dataset-Revision der eingegangenen Kerzen **inklusive**
 * Ingestion-Zeitstempel. Eine nachgelieferte oder revidierte Rohkerze erzeugt
 * damit einen anderen Hash; reine Neuberechnung derselben Kerzen nicht.
 */
export function datasetHashOf(
  window: readonly { time: number; open: number; high: number; low: number; close: number; volume: number; fetchedAt: string }[]
): string {
  const payload = window
    .map((bar) =>
      stableStringify({
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        fetchedAt: bar.fetchedAt,
      })
    )
    .join("\n");
  return `ds1:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/**
 * `fv1:<sha256>` — Inhaltsfingerprint eines Werts.
 *
 * Enthält `definitionHash`, Eventzeit, Wert, Null-Grund, Qualitätsstatus und
 * den **Dataset-Hash** — aber bewusst **nicht** `computedAt` (derselbe Wert,
 * später erneut berechnet, ist keine Revision) und nicht `availableAt` (eine
 * nachgelieferte Kerze ändert die Verfügbarkeit des *neuen* Laufs, nicht den
 * Inhalt bereits gespeicherter Zeilen).
 */
export function featureValueHash(draft: {
  featureId: string;
  featureVersion: number;
  definitionHash: string;
  entityType: string;
  entityId: string;
  timeframe: string;
  eventTime: Date;
  dtype: string;
  value: number | boolean | string | null;
  nullReason: string | null;
  qualityStatus: string;
  sourceManifest: { datasetHash: string };
}): string {
  const payload = stableStringify({
    featureId: draft.featureId,
    featureVersion: draft.featureVersion,
    definitionHash: draft.definitionHash,
    entityType: draft.entityType,
    entityId: draft.entityId,
    timeframe: draft.timeframe,
    eventTime: draft.eventTime.toISOString(),
    dtype: draft.dtype,
    value: draft.value,
    nullReason: draft.nullReason,
    qualityStatus: draft.qualityStatus,
    datasetHash: draft.sourceManifest.datasetHash,
  });
  return `fv1:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/**
 * Ordnet einen ATR-Kursanteil einem Band zu. Grenzen gehören zur **oberen**
 * Klasse (`atrPct = low` ⇒ `NORMAL`, `atrPct = high` ⇒ `HIGH`) — konsistent zu
 * `classifyRegime` im Scanner.
 */
export function atrBandOf(atrPct: number, thresholds: { low: number; high: number }): "LOW" | "NORMAL" | "HIGH" | null {
  if (!Number.isFinite(atrPct)) return null;
  if (atrPct < thresholds.low) return "LOW";
  if (atrPct < thresholds.high) return "NORMAL";
  return "HIGH";
}

function numericOutcome(definition: FeatureDefinition, value: number | null, reason: "INVALID_INPUT" | "NOT_COMPUTABLE"): FeatureComputeOutcome {
  if (value === null || !Number.isFinite(value)) return { kind: "null", reason };
  return { kind: "value", value: roundTo(value, definition.valueDecimals ?? 4) };
}

/** `scanner.rsi@1` — Wilder-RSI (0..100) der letzten geschlossenen Kerze. */
function rsiExecutor(ctx: FeatureComputeContext): FeatureComputeOutcome {
  const period = numberParam(ctx.definition, "period");
  const closes = ctx.window.map((bar) => bar.close);
  if (closes.length < period + 1) return { kind: "null", reason: "INSUFFICIENT_LOOKBACK" };
  if (!closes.every((close) => Number.isFinite(close) && close > 0)) return { kind: "null", reason: "INVALID_INPUT" };
  const value = computeRsi(closes, period);
  return numericOutcome(ctx.definition, value, "NOT_COMPUTABLE");
}

/**
 * `scanner.atr@1` — ATR als Anteil des letzten Schlusskurses.
 *
 * Identische Formel wie der Scanner-Faktor `atr` (gemeinsame Funktion
 * `computeAtrPct`) — der Wert ist damit zwischen Scanner und Feature Store
 * vergleichbar (Paritätstest in `tests/featureStore.test.ts`).
 */
function atrExecutor(ctx: FeatureComputeContext): FeatureComputeOutcome {
  const period = numberParam(ctx.definition, "period");
  if (ctx.window.length < period + 1) return { kind: "null", reason: "INSUFFICIENT_LOOKBACK" };
  const invalid = ctx.window.some((bar) => !Number.isFinite(bar.close) || bar.close <= 0 || !Number.isFinite(bar.high) || !Number.isFinite(bar.low));
  if (invalid) return { kind: "null", reason: "INVALID_INPUT" };
  const value = computeAtrPct(ctx.window, period);
  return numericOutcome(ctx.definition, value, "NOT_COMPUTABLE");
}

/**
 * `scanner.atr_band@1` — abgeleitetes Enum-Feature auf `scanner.atr`.
 *
 * Demonstriert die Abhängigkeitskante (topologische Ordnung, gleiche Eventzeit)
 * und die Fail-closed-Regel für Abhängigkeiten: fehlt der Abhängigkeitswert
 * oder ist er `null`, ist **auch** das abgeleitete Feature `null`
 * (`DEPENDENCY_MISSING`/`DEPENDENCY_NULL`) — es wird kein Band geraten und
 * insbesondere nicht `LOW` als „neutraler“ Ersatzwert gesetzt.
 */
function atrBandExecutor(ctx: FeatureComputeContext): FeatureComputeOutcome {
  const dependency = ctx.definition.dependencies[0];
  if (!dependency) return { kind: "null", reason: "DEPENDENCY_MISSING" };
  const dep = ctx.dependencies[dependency.featureId];
  if (!dep) return { kind: "null", reason: "DEPENDENCY_MISSING" };
  if (dep.kind === "null") return { kind: "null", reason: "DEPENDENCY_NULL" };
  if (typeof dep.value !== "number" || !Number.isFinite(dep.value)) return { kind: "null", reason: "DEPENDENCY_NULL" };
  const band = atrBandOf(dep.value, {
    low: numberParam(ctx.definition, "lowThreshold"),
    high: numberParam(ctx.definition, "highThreshold"),
  });
  if (band === null) return { kind: "null", reason: "DEPENDENCY_NULL" };
  const allowed = ctx.definition.enumValues ?? [];
  if (!allowed.includes(band)) {
    throw new FeatureStoreError(
      "FEATURE_DEFINITION_INVALID",
      `Definition ${ctx.definition.featureId}@${ctx.definition.version} erzeugte "${band}", das nicht in enumValues (${allowed.join(", ")}) liegt.`,
      { featureId: ctx.definition.featureId, version: ctx.definition.version }
    );
  }
  return { kind: "value", value: band };
}

/**
 * Executor-Tabelle des Slices. Jeder `computeKey` einer Definition **muss**
 * hier stehen — die Registry verifiziert das beim Aufbau.
 */
export const FEATURE_EXECUTORS: FeatureExecutorTable = Object.freeze({
  "scanner.rsi@1": rsiExecutor,
  "scanner.atr@1": atrExecutor,
  "scanner.atr_band@1": atrBandExecutor,
});
