/**
 * Materialisierung (RMA-P6-01, v1.53.0) — **reiner** Planer.
 *
 * Der Planer entscheidet, **welche** Featurewerte aus welchen Rohdaten
 * entstehen; er schreibt nichts. Persistenz, Idempotenz und Transaktionen liegen
 * in `./store.ts` (Drizzle) bzw. beim aufrufenden Lauf (`./service.ts`). Diese
 * Trennung macht die Kernlogik ohne Datenbank testbar — und verhindert, dass
 * ein DB-Fehler die Zeit-/Look-ahead-Semantik verändert.
 *
 * ── Deterministische Reihenfolge ───────────────────────────────────────────
 * 1. Definitionen in **topologischer** Ordnung (Abhängigkeiten zuerst,
 *    Tie-Break lexikografisch; siehe `FeatureRegistry.topoOrder`).
 * 2. Bars aufsteigend nach Schlusszeit (Eventzeit), Tie-Break über
 *    Ingestion-Zeitstempel und Rohindex.
 * Damit ist die Schreibreihenfolge reproduzierbar: gleiche Definitionen +
 * gleiche Rohdaten ⇒ gleiche Wertfolge.
 *
 * ── Bounded Batch und Cursor ───────────────────────────────────────────────
 * Ein Batch endet **auf einer Bargrenze** (alle Features desselben Bars sind
 * enthalten), sodass ein Neustart an genau dieser Grenze fortsetzt: Bars
 * `≤ watermarkEventTime` werden übersprungen, kein Wert wird doppelt
 * erzeugt. Der Wasserstand steht ausschließlich in `feature_values` –
 * dieselbe Zeile trägt `available_at`, `computed_at` und den
 * Definitions-Fingerprint.
 *
 * ── Idempotenz und Datenrevision ───────────────────────────────────────────
 * {@link featureValueHash} beschreibt den **Inhalt** eines Werts (ohne
 * Berechnungs- und Verfügbarkeitszeitpunkt, aber inklusive Dataset-Revision).
 * Daraus folgt:
 *
 *   * identischer Hash zum selben Schlüssel  ⇒ Duplikat, kein Write;
 *   * abweichender Hash (echte Datenrevision) ⇒ **kein** Überschreiben,
 *     sondern Protokolleintrag in `feature_data_revisions` (fail-closed;
 *     historische Werte bleiben reproduzierbar).
 */
import { createHash } from "node:crypto";

import { stableStringify } from "../lib/ruleEngine";
import { SUPPORTED_TIMEFRAME_MS, type SupportedTimeframe } from "../lib/marketdata/historicalStore";
import {
  availableAtOf,
  barCloseTime,
  closedBarsAt,
  datasetHashOf,
  featureValueHash,
  mapQualityClass,
  maxIngestedAtMs,
  windowQualityStatus,
} from "./compute";
import type { FeatureBarSource, FeatureRegistry } from "./registry";
import {
  FeatureStoreError,

  type FeatureCursor,
  type FeatureDataRevision,
  type FeatureDefinition,
  type FeatureMaterializationCounts,
  type FeatureNullReason,
  type FeatureQualityStatus,
  type FeatureRef,
  type FeatureSourceManifest,
  type FeatureValueDraft,
} from "./types";
import type { FeatureComputeOutcome } from "./registry";
import { assertValueMatchesDefinition } from "./validate";

/** Quelle der Rohdaten (Teil des Source-Manifests, code-konstant). */
export const HISTORICAL_STORE_SOURCE = "historical-store";

/** Leerer Zählerstand (für Manifeste und Tests). */
export function emptyCounts(): FeatureMaterializationCounts {
  return {
    barsConsidered: 0,
    skippedBeforeCursor: 0,
    gapBars: 0,
    valuesWritten: 0,
    duplicates: 0,
    revisions: 0,
    nullValues: 0,
  };
}

/**
 * `fm1:<sha256>` — Idempotency-Key eines Materialisierungslaufs.
 *
 * Der Schlüssel hängt an Definitionen (inkl. Fingerprints), Entities,
 * Zeitrahmen, Politik, Modus, Zeitfenster, **Dataset-Hashes** und Code-Version.
 * Ein Retry mit identischen Eingaben erzeugt damit denselben Schlüssel und
 * wird als Wiederholung erkannt; eine geänderte Rohdatenbasis erzeugt einen
 * anderen Schlüssel und damit einen echten neuen Lauf.
 */
export function materializationRunKey(input: {
  registry: FeatureRegistry;
  refs: readonly FeatureRef[];
  entityIds: readonly string[];
  timeframe: SupportedTimeframe;
  availabilityPolicy: string;
  mode: string;
  fromTs: number | null;
  toTs: number | null;
  /** Dataset-Hashes je Entity (`entityId → ds1:…`) oder `{}` (Trockenlauf). */
  datasetHashes: Readonly<Record<string, string>>;
  codeVersion: string;
}): string {
  const definitions = input.registry
    .topoOrder(input.refs)
    .map((def) => ({ featureId: def.featureId, version: def.version, definitionHash: def.definitionHash }));
  const payload = stableStringify({
    definitions,
    entityIds: [...input.entityIds].sort(),
    timeframe: input.timeframe,
    availabilityPolicy: input.availabilityPolicy,
    mode: input.mode,
    fromTs: input.fromTs,
    toTs: input.toTs,
    datasetHashes: Object.fromEntries(
      Object.entries(input.datasetHashes)
        .filter(([entityId]) => input.entityIds.includes(entityId))
        .sort(([a], [b]) => a.localeCompare(b))
    ),
    codeVersion: input.codeVersion,
  });
  return `fm1:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/** Eingabe eines Materialisierungsplans (eine Entity, ein Timeframe). */
export interface MaterializePlanInput {
  registry: FeatureRegistry;
  /** Gewünschte Features; Abhängigkeiten werden automatisch ergänzt. */
  refs: readonly FeatureRef[];
  entityId: string;
  timeframe: SupportedTimeframe;
  /** Rohkerzen der Reihe (alle Zeitstempel; Filterung erfolgt hier). */
  bars: readonly FeatureBarSource[];
  /** Materialisierungs-Horizont (ms): nur Bars mit Schlusszeit ≤ asOf. */
  asOf: number;
  /** Vorhandene Wasserstände (Cursor) der Reihe. */
  cursors?: readonly FeatureCursor[];
  availabilityPolicy: "bar_close" | "ingested";
  /** Berechnungszeitpunkt (injizierte Uhr). */
  computedAt: Date;
  /** Harte Obergrenze der Drafts je Batch. */
  maxRows: number;
  /**
   * Source-Quality je Bar (Eventzeit ms → Status). Fehlt die Angabe, gilt für
   * alle Bars `UNKNOWN` („nicht geprüft“) — Fail-closed statt `OK`.
   */
  qualityForBar?: (eventTimeMs: number) => FeatureQualityStatus;
}

/** Ergebnis eines Materialisierungsplans (noch nicht persistiert). */
export interface MaterializePlan {
  entityId: string;
  timeframe: SupportedTimeframe;
  drafts: readonly FeatureValueDraft[];
  /** Neue Wasserstände je Feature (nur Features mit Drafts). */
  cursors: readonly FeatureCursor[];
  counts: FeatureMaterializationCounts;
  /** `true`, wenn weitere, noch nicht geplante Bars vorliegen. */
  truncated: boolean;
  /** Dataset-Revision des jüngsten geplanten Werts (für das Run-Manifest). */
  sourceManifest: FeatureSourceManifest | null;
}

/** Plätze, an denen Rohdaten fehlen (Gegenstück zu `MISSING_BARS`-Werten). */
function countGapBars(eventTimes: readonly number[], timeframe: SupportedTimeframe): number {
  if (eventTimes.length < 2) return 0;
  const step = SUPPORTED_TIMEFRAME_MS[timeframe];
  if (!Number.isFinite(step) || step <= 0) return 0;
  let gaps = 0;
  for (let i = 1; i < eventTimes.length; i++) {
    const delta = eventTimes[i] - eventTimes[i - 1];
    if (delta <= step) continue;
    gaps += Math.max(0, Math.round(delta / step) - 1);
  }
  return gaps;
}

function nullOutcome(reason: FeatureNullReason): FeatureComputeOutcome {
  return { kind: "null", reason };
}

/**
 * Ist eine Rohkerze überhaupt verwertbar?
 *
 * Kriterien (identisch zur Engstelle im Scanner-Faktor `atr`): alle OHLC-Werte
 * endlich, `close > 0` und `high ≥ low`. Ein Bar, der das verletzt, ist keine
 * Marktbeobachtung, sondern ein Datenfehler.
 */
export function isUsableBar(bar: {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}): boolean {
  return (
    Number.isFinite(bar.time) &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    bar.close > 0 &&
    bar.high >= bar.low
  );
}

/**
 * Plant einen Batch für **eine** Entity und **einen** Timeframe.
 *
 * Der Planer validiert seine Eingaben fail-closed (unbekannte Features,
 * falscher Timeframe einer Definition, ungültige Entity-ID, fehlende Uhr) und
 * liefert sonst einen deterministischen Batch inklusive neuer Cursor.
 *
 * @throws {FeatureStoreError} `FEATURE_PLAN_INVALID` bei unbrauchbaren
 *   Eingaben, `FEATURE_UNKNOWN` bei nicht registrierten Features.
 */
export function planMaterialization(input: MaterializePlanInput): MaterializePlan {
  const fail = (message: string, detail?: Record<string, unknown>): never => {
    throw new FeatureStoreError("FEATURE_PLAN_INVALID", message, detail);
  };
  if (typeof input.entityId !== "string" || input.entityId.trim() === "" || input.entityId.length > 64) {
    fail("entityId fehlt oder ist zu lang (max. 64 Zeichen).");
  }
  if (!/^[\x20-\x7E]{1,64}$/.test(input.entityId)) {
    fail("entityId enthält unerlaubte Zeichen (druckbares ASCII erwartet).");
  }
  if (!Number.isFinite(input.asOf)) fail("asOf ist kein gültiger Zeitpunkt.");
  if (!(input.computedAt instanceof Date) || !Number.isFinite(input.computedAt.getTime())) {
    fail("computedAt ist keine gültige, injizierte Uhr.");
  }
  if (!Number.isInteger(input.maxRows) || input.maxRows < 1) fail("maxRows muss eine ganze Zahl ≥ 1 sein.");
  if (!Number.isFinite(SUPPORTED_TIMEFRAME_MS[input.timeframe])) fail(`unbekannter Timeframe "${String(input.timeframe)}".`);

  const ordered = input.registry.topoOrder(input.refs);
  for (const def of ordered) {
    if (def.timeframe !== input.timeframe) {
      fail(
        `Definition ${def.featureId}@${def.version} ist auf Timeframe "${def.timeframe}" deklariert, ` +
          `der Plan läuft aber auf "${input.timeframe}".`,
        { featureId: def.featureId, expected: def.timeframe, actual: input.timeframe }
      );
    }
  }

  const closed = closedBarsAt(input.bars, input.asOf, input.timeframe);
  /**
   * **Reihen-Validität als Ganzes (fail-closed):** Enthält die abgeschlossene
   * Eingangsmenge auch nur eine unbrauchbare Kerze, ist die Reihe nicht
   * vertrauenswürdig — dann entsteht für **jeden** Bar `INVALID_INPUT` und
   * kein Teilergebnis. Dieselbe Haltung wie im Scanner-Faktor `atr`
   * (`trueRangesOf` liefert bei kaputter Reihe `null`, nicht „fast alle“).
   *
   * Folge für den Betrieb: Taucht eine kaputte Kerze in einem bereits
   * materialisierten Zeitraum auf, weichen alle Werte ab ⇒ der Lauf wird als
   * Rohdatenrevision **verworfen** statt historische Werte zu überschreiben
   * (siehe {@link classifyDraftsAgainstExisting}).
   */
  const seriesInvalid = closed.some((bar) => !isUsableBar(bar));
  const cursorByFeature = new Map<string, number>();
  for (const cursor of input.cursors ?? []) {
    cursorByFeature.set(
      cursor.featureId,
      Math.max(cursorByFeature.get(cursor.featureId) ?? -Infinity, cursor.watermarkEventTime.getTime())
    );
  }

  const drafts: FeatureValueDraft[] = [];
  const counts = emptyCounts();
  const outcomeByFeature = new Map<string, Map<number, FeatureComputeOutcome>>();
  const lastEventTimeByFeature = new Map<string, number>();
  const lastAvailableByFeature = new Map<string, number>();
  const manifestByFeature = new Map<string, FeatureSourceManifest>();
  let truncated = false;
  const eventTimesSeen: number[] = [];

  for (let index = 0; index < closed.length; index++) {
    const bar = closed[index];
    const eventTimeMs = barCloseTime(bar, input.timeframe);
    eventTimesSeen.push(eventTimeMs);
    // Bars, die ALLE angefragten Features bereits abgedeckt haben, sind
    // Cursor-Fortschritt, kein neuer Wert.
    const coveredForAll = ordered.every((def) => eventTimeMs <= (cursorByFeature.get(def.featureId) ?? -Infinity));
    if (coveredForAll) {
      counts.skippedBeforeCursor += 1;
      continue;
    }
    if (drafts.length >= input.maxRows) {
      truncated = true;
      break;
    }
    counts.barsConsidered += 1;

    for (const def of ordered) {
      const cursor = cursorByFeature.get(def.featureId) ?? -Infinity;
      if (eventTimeMs <= cursor) continue; // Feature ist diesem Bar voraus
      const windowStart = Math.max(0, index - def.lookbackBars + 1);
      const window = closed.slice(windowStart, index + 1);
      const dependencies: Record<string, FeatureComputeOutcome> = {};
      for (const dep of def.dependencies) {
        const depOutcome = outcomeByFeature.get(dep.featureId)?.get(eventTimeMs);
        if (depOutcome) dependencies[dep.featureId] = depOutcome;
      }

      // Reihen-Invalidität schlägt auf Features ohne Abhängigkeiten durch.
      // Abgeleitete Features bleiben bei ihrer präzisen Begründung: fehlt der
      // Abhängigkeitswert (z. B. weil die Reihe kaputt ist), ist der Grund
      // `DEPENDENCY_NULL` — das ist die eigentliche Ursache der Nichtverfügbarkeit.
      const outcome: FeatureComputeOutcome =
        seriesInvalid && def.dependencies.length === 0
          ? nullOutcome("INVALID_INPUT")
          : window.length < def.lookbackBars
            ? nullOutcome("INSUFFICIENT_LOOKBACK")
            : input.registry.executorFor(def)({ definition: def, window, dependencies });

      const sourceManifest = sourceManifestOf({
        window,
        timeframe: input.timeframe,
        eventTimeMs,
        availabilityPolicy: input.availabilityPolicy,
      });
      const availableAtMs = availableAtOf({
        eventTimeMs,
        maxIngestedAtMs: maxIngestedAtMs(window),
        policy: input.availabilityPolicy,
      });
      const qualityStatus =
        window.length === 0
          ? "UNKNOWN"
          : windowQualityStatus(
              window.map((windowBar) => {
                const eventTime = barCloseTime(windowBar, input.timeframe);
                return input.qualityForBar ? mapQualityClass(input.qualityForBar(eventTime)) : "UNKNOWN";
              })
            );
      const base = {
        featureId: def.featureId,
        featureVersion: def.version,
        entityType: def.entityType,
        entityId: input.entityId,
        timeframe: input.timeframe,
        dtype: def.dtype,
        eventTime: new Date(eventTimeMs),
        availableAt: new Date(availableAtMs),
        computedAt: input.computedAt,
        value: outcome.kind === "value" ? outcome.value : null,
        nullReason: outcome.kind === "null" ? outcome.reason : null,
        qualityStatus,
        definitionHash: def.definitionHash,
        sourceManifest,
      } as const;
      const draft: FeatureValueDraft = {
        ...base,
        valueHash: featureValueHash(base),
      };
      // Fail-closed direkt beim Planen: eine Zeile, die die Invarianten
      // (NULL-Semantik, Dtype, Zeitordnung, Lookback) verletzt, entsteht gar nicht.
      assertValueMatchesDefinition(draft, def);
      drafts.push(draft);
      if (draft.value === null) counts.nullValues += 1;

      const perFeature = outcomeByFeature.get(def.featureId) ?? new Map<number, FeatureComputeOutcome>();
      perFeature.set(eventTimeMs, outcome);
      outcomeByFeature.set(def.featureId, perFeature);
      lastEventTimeByFeature.set(def.featureId, eventTimeMs);
      lastAvailableByFeature.set(def.featureId, availableAtMs);
      manifestByFeature.set(def.featureId, sourceManifest);
    }
  }

  counts.gapBars = countGapBars(eventTimesSeen, input.timeframe);
  const cursors: FeatureCursor[] = ordered
    .filter((def) => lastEventTimeByFeature.has(def.featureId))
    .map((def) => ({
      featureId: def.featureId,
      featureVersion: def.version,
      entityId: input.entityId,
      timeframe: input.timeframe,
      watermarkEventTime: new Date(lastEventTimeByFeature.get(def.featureId) as number),
      watermarkAvailableAt: new Date(lastAvailableByFeature.get(def.featureId) as number),
      lastRunId: null,
    }));

  // Das Run-Manifest trägt EINEN Source-Manifest je Entity: den des jüngsten
  // geplanten Werts (die frischeste Dataset-Revision des Laufs).
  const manifest = pickLatestManifest(manifestByFeature, lastEventTimeByFeature);

  return {
    entityId: input.entityId,
    timeframe: input.timeframe,
    drafts: Object.freeze(drafts),
    cursors: Object.freeze(cursors),
    counts,
    truncated,
    sourceManifest: manifest,
  };
}

function pickLatestManifest(
  manifests: ReadonlyMap<string, FeatureSourceManifest>,
  lastEventTimeByFeature: ReadonlyMap<string, number>
): FeatureSourceManifest | null {
  let best: FeatureSourceManifest | null = null;
  let bestTime = -Infinity;
  for (const [featureId, manifest] of manifests) {
    const time = lastEventTimeByFeature.get(featureId) ?? -Infinity;
    if (time > bestTime || (time === bestTime && best !== null && manifest.datasetHash < best.datasetHash)) {
      best = manifest;
      bestTime = time;
    }
  }
  return best;
}

/** Baut das Source-Manifest eines Fensters (Provenienz bis zur Rohkerze). */
export function sourceManifestOf(args: {
  window: readonly FeatureBarSource[];
  timeframe: SupportedTimeframe;
  eventTimeMs: number;
  availabilityPolicy: "bar_close" | "ingested";
}): FeatureSourceManifest {
  const first = args.window[0]?.time ?? args.eventTimeMs;
  const last = args.window.length > 0 ? barCloseTime(args.window[args.window.length - 1], args.timeframe) : args.eventTimeMs;
  const ingested = maxIngestedAtMs(args.window);
  return Object.freeze({
    source: HISTORICAL_STORE_SOURCE,
    candleCount: args.window.length,
    firstEventTime: new Date(first).toISOString(),
    lastEventTime: new Date(last).toISOString(),
    maxIngestedAt: new Date(Number.isFinite(ingested) ? ingested : args.eventTimeMs).toISOString(),
    datasetHash: datasetHashOf(args.window),
    availabilityPolicy: args.availabilityPolicy,
  });
}

/** Schlüssel eines Featurewerts (`feature + version + entity + timeframe + eventTime`). */
export function valueKey(
  featureId: string,
  featureVersion: number,
  entityId: string,
  timeframe: string,
  eventTime: Date
): string {
  return `${featureId}\u0000${featureVersion}\u0000${entityId}\u0000${timeframe}\u0000${eventTime.toISOString()}`;
}

/**
 * Wertet vorhandene Zeilen gegen neu geplante Drafts aus (reine Funktion).
 *
 * Ergebnis:
 *   * `written`     — Schlüssel existiert noch nicht ⇒ schreiben;
 *   * `duplicates`  — identischer Inhalt (Hash) ⇒ nichts schreiben;
 *   * `revision`    — **erster** abweichender Inhalt zum selben Schlüssel
 *     (Rohdatenrevision) ⇒ der Aufrufer verwirft den **gesamten** Batch
 *     (fail-closed) und protokolliert den Befund; es wird nichts überschrieben;
 *   * `definitionDrift` — gespeicherte Zeile wurde mit einer **anderen**
 *     Definition erzeugt als der heute registrierten (Gleiches
 *     `(featureId, version)`, anderer `definitionHash`) ⇒ Betriebsalarm; neue
 *     Semantik braucht eine neue Version, historische Werte bleiben unberührt.
 *
 * Der Scan läuft nach dem ersten Befund weiter, damit `duplicates` und
 * `definitionDrift` vollständig sind — es wird aber **nur der erste** Befund
 * zurückgegeben: ein Lauf, der einen Widerspruch berührt, ist als Ganzes
 * ungültig; der Operator klärt die Rohdatenbasis und startet neu (statt eine
 * Flut von Folgeabweichungen einzeln zu protokollieren).
 */
export function classifyDraftsAgainstExisting(
  drafts: readonly FeatureValueDraft[],
  existing: readonly {
    featureId: string;
    featureVersion: number;
    entityId: string;
    timeframe: string;
    eventTime: Date;
    valueHash: string;
    definitionHash: string;
  }[],
  registry: FeatureRegistry
): {
  written: readonly FeatureValueDraft[];
  duplicates: number;
  revision: FeatureDataRevision | null;
  definitionDrift: readonly FeatureRef[];
} {
  const byKey = new Map<string, { valueHash: string; definitionHash: string }>();
  for (const row of existing) {
    byKey.set(valueKey(row.featureId, row.featureVersion, row.entityId, row.timeframe, row.eventTime), {
      valueHash: row.valueHash,
      definitionHash: row.definitionHash,
    });
  }
  const written: FeatureValueDraft[] = [];
  let revision: FeatureDataRevision | null = null;
  const drift = new Map<string, FeatureRef>();
  let duplicates = 0;
  for (const draft of drafts) {
    // Fail-closed: ein Draft, den die Registry nicht (mehr) in dieser Form
    // kennt, darf nie geschrieben werden.
    const definition = registry.get({ featureId: draft.featureId, version: draft.featureVersion });
    if (!definition) {
      throw new FeatureStoreError(
        "FEATURE_UNKNOWN",
        `Draft ${draft.featureId}@${draft.featureVersion} ist nicht (mehr) registriert — kein Write mit unbekannter Semantik.`,
        { featureId: draft.featureId, version: draft.featureVersion }
      );
    }
    if (definition.definitionHash !== draft.definitionHash) {
      throw new FeatureStoreError(
        "FEATURE_VALUE_INVALID",
        `Draft ${draft.featureId}@${draft.featureVersion} trägt einen anderen Definitions-Fingerprint als die Registry ` +
          "(Definition geändert, Version nicht erhöht) — fail-closed.",
        { featureId: draft.featureId, version: draft.featureVersion }
      );
    }
    const key = valueKey(draft.featureId, draft.featureVersion, draft.entityId, draft.timeframe, draft.eventTime);
    const known = byKey.get(key);
    if (known === undefined) {
      written.push(draft);
      continue;
    }
    if (known.valueHash === draft.valueHash) {
      duplicates += 1;
      continue;
    }
    if (revision === null) {
      revision = {
        featureId: draft.featureId,
        featureVersion: draft.featureVersion,
        entityId: draft.entityId,
        timeframe: draft.timeframe,
        eventTime: draft.eventTime,
        existingValueHash: known.valueHash,
        incomingValueHash: draft.valueHash,
        detectedAt: draft.computedAt,
        runId: null,
      };
    }
    // Definitionsdrift: die gespeicherte Zeile wurde mit einer ANDEREN
    // Definition erzeugt als der heute registrierten ⇒ neue Semantik braucht
    // eine neue Version (kein stilles Überschreiben historischer Werte).
    if (known.definitionHash !== draft.definitionHash) {
      drift.set(`${draft.featureId}@${draft.featureVersion}`, {
        featureId: draft.featureId,
        version: draft.featureVersion,
      });
    }
  }
  return {
    written: Object.freeze(revision === null ? written : []),
    duplicates,
    revision,
    definitionDrift: Object.freeze([...drift.values()]),
  };
}

/** Registry-konforme Kennung eines Definitionspaars (`featureId@version`). */
export function refKey(ref: FeatureRef): string {
  return `${ref.featureId}@${ref.version}`;
}

/** Alle Definitions-Fingerprints einer Menge (Manifest-Eintrag). */
export function definitionHashesOf(registry: FeatureRegistry, refs: readonly FeatureRef[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of registry.topoOrder(refs)) out[refKey(def)] = def.definitionHash;
  return out;
}

/** Definition zu einer Referenz oder Fehler (Kurzform für Aufrufer). */
export function requireDefinition(registry: FeatureRegistry, ref: FeatureRef): FeatureDefinition {
  return registry.require(ref);
}
