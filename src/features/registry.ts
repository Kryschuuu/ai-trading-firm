/**
 * Feature-Registry (RMA-P6-01, v1.53.0) — **unveränderliche** Definitionsquelle.
 *
 * Die Registry ist die einzige Stelle, an der definiert wird, *was* ein Feature
 * bedeutet: ID, Semantikversion, Dtype, Einheit, Zeitrahmen, Lookback,
 * Abhängigkeiten, Code-/Config-Fingerprint und Owner. Drei Eigenschaften sind
 * bewusst und werden getestet:
 *
 * 1. **Unveränderlichkeit.** Eine Änderung an irgendeinem Definitionsfeld
 *    erzeugt einen anderen `definitionHash`. Wird dieselbe `(featureId, version)`
 *    mit einem anderen Hash registriert, wird der Vorgang fail-closed abgelehnt
 *    (`FEATURE_DEFINITION_IMMUTABLE`). Neue Semantik heißt: neue `version`
 *    (und ein Backfill über die CLI — nie ein stilles Überschreiben).
 * 2. **Determinismus.** Alle Hash-Eingaben werden über `stableStringify`
 *    kanonisiert; die topologische Sortierung hat einen lexikografischen
 *    Tie-Break. Gleiche Definitionen ⇒ gleiche Fingerprints, gleiche Reihenfolge.
 * 3. **Keine toten Verweise.** Ein `computeKey` ohne Executor, eine fehlende
 *    Abhängigkeit oder ein Zyklus machen den Prozessstart kaputt statt später
 *    einen falschen Wert zu erzeugen.
 */
import { createHash } from "node:crypto";

import { stableStringify } from "../lib/ruleEngine";
import { FEATURE_LIMITS, FeatureStoreError, type FeatureDefinition, type FeatureDefinitionInput, type FeatureRef } from "./types";
import { assertValidDefinition } from "./validate";

/** Kontext einer Berechnung (Fenster + bereits berechnete Abhängigkeiten). */
export interface FeatureComputeContext {
  definition: FeatureDefinition;
  /**
   * Abgeschlossene Kerzen, aufsteigend nach Eventzeit, höchstens so viele wie
   * nötig (Lookback). Der Aufrufer stellt sicher, dass nur Bars mit
   * `time + timeframe ≤ asOf` enthalten sind.
   */
  window: readonly FeatureBarSource[];
  /** Werte der direkten Abhängigkeiten, geschlüsselt mit `featureId`. */
  dependencies: Readonly<Record<string, FeatureComputeOutcome>>;
}

/** Minimale Kerzensicht der Berechnung (Struktur-kompatibel zum Historical Store). */
export interface FeatureBarSource {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Ingestion-Zeitstempel (ISO-8601-UTC) — Basis der Politik `ingested`. */
  fetchedAt: string;
}

/** Ergebnis einer Featureberechnung: Wert oder explizite Nichtverfügbarkeit. */
export type FeatureComputeOutcome =
  | { kind: "value"; value: number | boolean | string }
  | { kind: "null"; reason: import("./types").FeatureNullReason };

/** Reine Berechnungsfunktion (kein IO, keine Uhr, kein Zufall). */
export type FeatureExecutor = (ctx: FeatureComputeContext) => FeatureComputeOutcome;

/** Executor-Tabelle: `computeKey` → Funktion. */
export type FeatureExecutorTable = Readonly<Record<string, FeatureExecutor>>;

/** Kanonischer Schlüssel einer Featureversion. */
export function definitionKey(featureId: string, version: number): string {
  return `${featureId}@${version}`;
}

/**
 * `fc1:<sha256>` — Fingerprint des **Berechnungsvertrags** (Executor + Fenster +
 * Ausgabetyp). Er ändert sich, wenn ein Feature auf eine andere Formel oder
 * einen anderen Lookback zeigt — genau die Fälle, in denen alte Werte und neue
 * Semantik nicht mehr zusammenpassen.
 */
export function codeHashOf(input: FeatureDefinitionInput): string {
  const payload = stableStringify({
    computeKey: input.computeKey,
    dtype: input.dtype,
    enumValues: input.enumValues ? [...input.enumValues] : null,
    unit: input.unit,
    valueDecimals: input.valueDecimals,
    lookbackBars: input.lookbackBars,
    dependencies: input.dependencies
      .map((dep) => ({ featureId: dep.featureId, version: dep.version }))
      .sort((a, b) => a.featureId.localeCompare(b.featureId) || a.version - b.version),
  });
  return `fc1:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/** `fg1:<sha256>` — Fingerprint der Berechnungskonfiguration. */
export function configHashOf(input: FeatureDefinitionInput): string {
  const config = Object.fromEntries(
    Object.entries(input.config)
      .map(([key, value]) => [key, value] as const)
      .sort(([a], [b]) => a.localeCompare(b))
  );
  return `fg1:${createHash("sha256").update(stableStringify(config), "utf8").digest("hex")}`;
}

/**
 * `fd1:<sha256>` — Fingerprint der **gesamten** Definition (einschließlich
 * Doku-Feldern und Owner). Zwei Registrierungen mit gleicher `(featureId, version)`
 * und unterschiedlichem `fd1` sind eine Umdeutung und daher unzulässig.
 */
export function definitionHashOf(input: FeatureDefinitionInput): string {
  const payload = stableStringify({
    featureId: input.featureId,
    version: input.version,
    label: input.label,
    description: input.description,
    dtype: input.dtype,
    enumValues: input.enumValues ? [...input.enumValues] : null,
    unit: input.unit,
    valueDecimals: input.valueDecimals,
    entityType: input.entityType,
    timeframe: input.timeframe,
    lookbackBars: input.lookbackBars,
    dependencies: input.dependencies
      .map((dep) => ({ featureId: dep.featureId, version: dep.version }))
      .sort((a, b) => a.featureId.localeCompare(b.featureId) || a.version - b.version),
    computeKey: input.computeKey,
    config: Object.fromEntries(
      Object.entries(input.config)
        .map(([key, value]) => [key, value] as const)
        .sort(([a], [b]) => a.localeCompare(b))
    ),
    owner: input.owner,
    codeHash: codeHashOf(input),
    configHash: configHashOf(input),
  });
  return `fd1:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/** Friert Input, Config und Abhängigkeiten ein und berechnet die Fingerprints. */
export function freezeDefinition(input: FeatureDefinitionInput): FeatureDefinition {
  assertValidDefinition(input);
  return Object.freeze({
    ...input,
    enumValues: input.enumValues ? Object.freeze([...input.enumValues]) : null,
    dependencies: Object.freeze(input.dependencies.map((dep) => Object.freeze({ ...dep }))),
    config: Object.freeze({ ...input.config }),
    codeHash: codeHashOf(input),
    configHash: configHashOf(input),
    definitionHash: definitionHashOf(input),
  });
}

function keyOf(ref: FeatureRef): string {
  return definitionKey(ref.featureId, ref.version);
}

/**
 * Immutable Registry.
 *
 * @example
 * ```ts
 * const registry = buildRegistry(FEATURE_DEFINITIONS, FEATURE_EXECUTORS);
 * registry.topoOrder([{ featureId: "scanner.atr_band", version: 1 }])
 *   .map((d) => d.featureId); // ["scanner.atr", "scanner.atr_band"]
 * ```
 */
export class FeatureRegistry {
  private readonly byKey: ReadonlyMap<string, FeatureDefinition>;
  private readonly byFeatureId: ReadonlyMap<string, readonly FeatureDefinition[]>;
  private readonly executors: FeatureExecutorTable;

  private constructor(definitions: readonly FeatureDefinition[], executors: FeatureExecutorTable) {
    const byKey = new Map<string, FeatureDefinition>();
    const byFeatureId = new Map<string, FeatureDefinition[]>();
    for (const def of definitions) {
      byKey.set(keyOf(def), def);
      const list = byFeatureId.get(def.featureId) ?? [];
      list.push(def);
      byFeatureId.set(def.featureId, list);
    }
    for (const list of byFeatureId.values()) {
      list.sort((a, b) => a.version - b.version);
      Object.freeze(list);
    }
    this.byKey = byKey;
    this.byFeatureId = byFeatureId;
    this.executors = executors;
  }

  /**
   * Baut eine Registry aus Deklarationen.
   *
   * @throws {FeatureStoreError}
   *   * `FEATURE_DEFINITION_INVALID` — Feld-/Muster-/Bereichsfehler.
   *   * `FEATURE_DEFINITION_IMMUTABLE` — gleiche `(featureId, version)`,
   *     abweichender Definitions-Hash (Umdeutung).
   *   * `FEATURE_DEPENDENCY_MISSING` — Abhängigkeit nicht Teil der Registry.
   *   * `FEATURE_DEPENDENCY_CYCLE` — Abhängigkeitsgraph enthält einen Zyklus.
   *   * `FEATURE_EXECUTOR_MISSING` — `computeKey` hat keine Implementierung.
   */
  static create(inputs: readonly FeatureDefinitionInput[], executors: FeatureExecutorTable): FeatureRegistry {
    const definitions: FeatureDefinition[] = [];
    const seen = new Map<string, FeatureDefinition>();
    for (const input of inputs) {
      assertValidDefinition(input);
      const frozen = freezeDefinition(input);
      const key = keyOf(frozen);
      const existing = seen.get(key);
      if (existing) {
        if (existing.definitionHash !== frozen.definitionHash) {
          throw new FeatureStoreError(
            "FEATURE_DEFINITION_IMMUTABLE",
            `Definition ${key} existiert bereits mit einem anderen Definitions-Fingerprint. ` +
              "Definitionen sind unveränderlich — neue Semantik braucht eine neue Version.",
            { featureId: frozen.featureId, version: frozen.version }
          );
        }
        continue; // identische Doppelmeldung: idempotent
      }
      seen.set(key, frozen);
      definitions.push(frozen);
    }

    // Executor-Verdrahtung: kein toter Definitionsverweis.
    for (const def of definitions) {
      if (typeof executors[def.computeKey] !== "function") {
        throw new FeatureStoreError(
          "FEATURE_EXECUTOR_MISSING",
          `Definition ${keyOf(def)} verweist auf computeKey "${def.computeKey}", der in der Executor-Tabelle fehlt.`,
          { featureId: def.featureId, version: def.version, computeKey: def.computeKey }
        );
      }
    }

    // Abhängigkeiten müssen existieren (exakte Version) und azyklisch sein.
    for (const def of definitions) {
      for (const dep of def.dependencies) {
        if (!seen.has(keyOf(dep))) {
          throw new FeatureStoreError(
            "FEATURE_DEPENDENCY_MISSING",
            `Definition ${keyOf(def)} hängt von ${keyOf(dep)} ab, die nicht (in dieser Version) registriert ist.`,
            { featureId: def.featureId, version: def.version, dependency: dep.featureId }
          );
        }
      }
    }
    definitions.sort((a, b) => a.featureId.localeCompare(b.featureId) || a.version - b.version);
    const registry = new FeatureRegistry(Object.freeze(definitions), executors);
    // Zyklusprüfung über alle Definitionen (einmalig, deterministisch).
    registry.topoOrder(
      definitions.map((def) => ({ featureId: def.featureId, version: def.version }))
    );
    return registry;
  }

  /** Alle Definitionen in kanonischer Reihenfolge (`featureId`, dann `version`). */
  definitions(): readonly FeatureDefinition[] {
    return [...this.byKey.values()].sort((a, b) => a.featureId.localeCompare(b.featureId) || a.version - b.version);
  }

  /** Alle Versionen einer Feature-ID, aufsteigend (leer, wenn unbekannt). */
  versions(featureId: string): readonly FeatureDefinition[] {
    return this.byFeatureId.get(featureId) ?? [];
  }

  /** Neueste registrierte Version oder `undefined`. */
  latest(featureId: string): FeatureDefinition | undefined {
    const list = this.byFeatureId.get(featureId);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  /** Exakter Treffer; ohne `version` die neueste registrierte Version. */
  get(ref: FeatureRef | { featureId: string }): FeatureDefinition | undefined {
    const version = (ref as FeatureRef).version;
    if (version === undefined) return this.latest(ref.featureId);
    return this.byKey.get(keyOf(ref as FeatureRef));
  }

  /** Wie {@link get}, aber fail-closed: unbekannte Referenz ⇒ Fehler. */
  require(ref: FeatureRef | { featureId: string }): FeatureDefinition {
    const def = this.get(ref);
    if (!def) {
      throw new FeatureStoreError(
        "FEATURE_UNKNOWN",
        `Feature ${ref.featureId}${(ref as FeatureRef).version !== undefined ? `@${(ref as FeatureRef).version}` : ""} ist nicht registriert.`,
        { featureId: ref.featureId }
      );
    }
    return def;
  }

  /** Implementierung eines `computeKey` (fail-closed). */
  executorFor(def: FeatureDefinition): FeatureExecutor {
    const executor = this.executors[def.computeKey];
    if (!executor) {
      throw new FeatureStoreError("FEATURE_EXECUTOR_MISSING", `Keine Implementierung für computeKey "${def.computeKey}".`, {
        featureId: def.featureId,
        version: def.version,
      });
    }
    return executor;
  }

  /**
   * Schließt die Abhängigkeiten transitiv ab und liefert die Definitionen in
   * **topologischer Reihenfolge** (Abhängigkeiten zuerst, lexikografischer
   * Tie-Break).
   *
   * @throws {FeatureStoreError} `FEATURE_UNKNOWN` (unbekannte Referenz),
   *   `FEATURE_DEPENDENCY_CYCLE` (Zyklus).
   */
  topoOrder(refs: readonly FeatureRef[]): readonly FeatureDefinition[] {
    const wanted = new Set<string>();
    const stack = refs.map(keyOf);
    while (stack.length > 0) {
      const key = stack.pop() as string;
      if (wanted.has(key)) continue;
      const def = this.byKey.get(key);
      if (!def) {
        throw new FeatureStoreError("FEATURE_UNKNOWN", `Feature ${key} ist nicht registriert.`, { key });
      }
      wanted.add(key);
      for (const dep of def.dependencies) stack.push(keyOf(dep));
    }

    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const key of wanted) {
      indegree.set(key, 0);
      dependents.set(key, []);
    }
    for (const key of wanted) {
      const def = this.byKey.get(key) as FeatureDefinition;
      for (const dep of def.dependencies) {
        const depKey = keyOf(dep);
        indegree.set(key, (indegree.get(key) ?? 0) + 1);
        (dependents.get(depKey) as string[]).push(key);
      }
    }

    const ready = [...wanted].filter((key) => (indegree.get(key) ?? 0) === 0).sort((a, b) => a.localeCompare(b));
    const ordered: FeatureDefinition[] = [];
    while (ready.length > 0) {
      const key = ready.shift() as string;
      ordered.push(this.byKey.get(key) as FeatureDefinition);
      for (const next of (dependents.get(key) ?? []).sort((a, b) => a.localeCompare(b))) {
        const remaining = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, remaining);
        if (remaining === 0) {
          ready.push(next);
          ready.sort((a, b) => a.localeCompare(b));
        }
      }
    }
    if (ordered.length !== wanted.size) {
      const stuck = [...wanted].filter((key) => (indegree.get(key) ?? 0) > 0).sort((a, b) => a.localeCompare(b));
      throw new FeatureStoreError(
        "FEATURE_DEPENDENCY_CYCLE",
        `Abhängigkeitszyklus erkannt: ${stuck.slice(0, 5).join(", ")}` + (stuck.length > 5 ? ` (+${stuck.length - 5} weitere)` : ""),
        { cycle: stuck.slice(0, 10) }
      );
    }
    return Object.freeze(ordered);
  }

  /** Direkte Abhängige einer Version (Reverse-Kanten, sortiert). */
  dependentsOf(ref: FeatureRef): readonly FeatureDefinition[] {
    const key = keyOf(ref);
    return this.definitions().filter((def) => def.dependencies.some((dep) => keyOf(dep) === key));
  }

  /** Maximale Fenstergröße einer Definitionsmenge (für bounded Batching). */
  maxLookbackBars(refs: readonly FeatureRef[]): number {
    return this.topoOrder(refs).reduce((max, def) => Math.max(max, def.lookbackBars), 0);
  }
}

/** Baut eine Registry und gibt die maximale Entity-Anzahl-Schranke mit aus. */
export function buildRegistry(
  inputs: readonly FeatureDefinitionInput[],
  executors: FeatureExecutorTable
): { registry: FeatureRegistry; entityLimit: number } {
  return { registry: FeatureRegistry.create(inputs, executors), entityLimit: FEATURE_LIMITS.materializeEntities };
}
