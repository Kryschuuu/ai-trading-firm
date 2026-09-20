/**
 * Point-in-Time-Abfrage (RMA-P6-01, v1.53.0) — **reiner** Join.
 *
 * Die Abfrage beantwortet genau eine Frage:
 *
 * > Welchen Wert hatte Feature X für Entity E zum Zielzeitpunkt `targetTime`,
 * > wenn ich nur Informationen verwenden darf, die bis `as_of` bekannt waren?
 *
 * Formale Regel (die einzige Zulässigkeitsbedingung):
 *
 * ```text
 * event_time   <= targetTime     (das Ereignis liegt nicht in der Zukunft)
 * available_at <= asOf           (der Wert war tatsächlich bekannt)
 * ```
 *
 * Aus den zulässigen Zeilen gewinnt die **jüngste Eventzeit**; bei Gleichstand
 * deterministisch die später verfügbare, dann der größere Inhalts-Hash (stabil
 * über Prozessläufe und Neuberechnungen).
 *
 * ── Fail-closed-Antworten ──────────────────────────────────────────────────
 * Es gibt **keine** Ersatzwerte. Ein nicht gefundener Wert ist `MISSING`, ein
 * gefundener Wert mit `value = null` ist `NULL_VALUE` — beide mit `value: null`
 * in der Antwort. `0` in einer Antwort bedeutet immer „gemessene Null“, nie
 * „unbekannt“. `stale` markiert Werte, deren **Informationsalter** gegenüber
 * `asOf` größer als ein Zeitrahmen (bzw. als das injizierte `maxLagMs`) ist —
 * gemessen ab dem späteren der beiden Zeitpunkte `available_at`/`event_time`.
 * Die Entscheidung, ob ein solcher Wert verwendet werden darf, bleibt beim
 * Consumer (der Store trifft sie nicht).
 */
import {
  SUPPORTED_TIMEFRAME_MS,
  isSupportedTimeframe,
  type SupportedTimeframe,
} from "../lib/marketdata/historicalStore";
import {
  FEATURE_LIMITS,
  FeatureStoreError,
  type FeatureDtype,
  type FeaturePitResult,
  type FeaturePitStatus,
  type FeaturePitValue,
  type FeatureQualityStatus,
  type FeatureQuerySpec,
  type FeatureRef,
  type FeatureValueRow,
} from "./types";
import type { FeatureRegistry } from "./registry";

/** Zulässige Rohzeilen einer Abfrage (Quellzeilen, nicht Ergebniszeilen). */
export interface PitSource {
  /**
   * Lädt – begrenzt – alle Zeilen, die für die Abfrage in Frage kommen.
   * Implementierungen MÜSSEN harte Limits anwenden (siehe `./store.ts`).
   */
  readValues(query: {
    entities: readonly string[];
    refs: readonly FeatureRef[];
    timeframe: SupportedTimeframe;
    asOf: Date;
    targetTime: Date;
    limit: number;
  }): Promise<readonly FeatureValueRow[]>;
}

/** Geprüfte PIT-Anfrage (nach {@link validatePitQuery}). */
export interface PitQueryRequest {
  asOf: Date;
  entities: readonly string[];
  features: readonly FeatureQuerySpec[];
  timeframe: SupportedTimeframe;
  /** Zielzeit je Abfrage (Default: `asOf`). */
  targetTime: Date;
}

/** Ergebnis der Validierung einer externen PIT-Anfrage. */
export type PitQueryValidation = { ok: true; request: PitQueryRequest } | { ok: false; error: string };

function parseTimestamp(raw: unknown, field: string): { ok: true; value: Date | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, error: `INVALID_${field}: Zeitstempel als ISO-8601-String erwartet.` };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return { ok: false, error: `INVALID_${field}: "${raw.slice(0, 40)}" ist kein gültiger ISO-8601-Zeitstempel.` };
  }
  return { ok: true, value: new Date(ms) };
}

/**
 * Validiert eine PIT-Anfrage aus einer externen Quelle (HTTP-Query, CLI).
 *
 * Geprüft werden: Zeitstempel-Format, nicht-leere/duplikatfreie Entity- und
 * Feature-Listen, Längen- und Mengen-Grenzen (`FEATURE_LIMITS`) sowie die
 * Reihenfolge `asOf`/`targetTime`. Jede Verletzung ist ein Fehler — es gibt
 * keine stillen Defaults für Nutzereingaben.
 */
export function validatePitQuery(raw: {
  asOf?: unknown;
  targetTime?: unknown;
  entities?: unknown;
  features?: unknown;
  timeframe?: unknown;
  maxLagMs?: unknown;
}): PitQueryValidation {
  const asOf = parseTimestamp(raw.asOf, "AS_OF");
  if (!asOf.ok) return asOf;
  if (!asOf.value) return { ok: false, error: "MISSING_AS_OF: `asOf` ist Pflicht (ISO-8601)." };
  const target = parseTimestamp(raw.targetTime, "TARGET_TIME");
  if (!target.ok) return target;

  if (!isSupportedTimeframe(raw.timeframe)) {
    return {
      ok: false,
      error: `INVALID_TIMEFRAME: erwartet einer der erlaubten Timeframes, erhalten "${String(raw.timeframe).slice(0, 20)}".`,
    };
  }
  const timeframe = raw.timeframe;

  const parseList = (
    value: unknown,
    field: string,
    max: number,
    pattern: RegExp
  ): { ok: true; items: string[] } | { ok: false; error: string } => {
    const rawItems =
      typeof value === "string"
        ? value.split(",").map((entry) => entry.trim())
        : Array.isArray(value)
          ? value.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          : [];
    const items = rawItems.filter((entry) => entry !== "");
    if (items.length === 0) return { ok: false, error: `MISSING_${field}: mindestens ein Eintrag ist Pflicht.` };
    if (items.length > max) {
      return { ok: false, error: `LIMIT_${field}: maximal ${max} Einträge erlaubt (erhalten ${items.length}).` };
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (item.length > FEATURE_LIMITS.entityIdLength || !pattern.test(item)) {
        return { ok: false, error: `INVALID_${field}: "${item.slice(0, 40)}" ist kein zulässiger Bezeichner.` };
      }
      if (seen.has(item)) return { ok: false, error: `INVALID_${field}: "${item.slice(0, 40)}" ist doppelt angegeben.` };
      seen.add(item);
    }
    return { ok: true, items };
  };

  const entities = parseList(raw.entities, "ENTITIES", FEATURE_LIMITS.pitEntities, /^[A-Za-z0-9_.:/\-@]{1,64}$/);
  if (!entities.ok) return entities;
  // Feature-Eintrag: `featureId` oder `featureId:version` (Version 1..9999).
  const featureItems = parseList(raw.features, "FEATURES", FEATURE_LIMITS.pitFeatures, /^[a-z0-9_.]{1,59}(?::[1-9][0-9]{0,3})?$/);
  if (!featureItems.ok) return featureItems;

  const features: FeatureQuerySpec[] = [];
  for (const entry of featureItems.items) {
    const [featureId, versionRaw] = entry.split(":");
    if (versionRaw === undefined) {
      features.push({ featureId });
      continue;
    }
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 1) {
      return { ok: false, error: `INVALID_FEATURES: "${entry.slice(0, 40)}" hat keine gültige Version.` };
    }
    features.push({ featureId, version });
  }

  const asOfValue = asOf.value;
  const targetTime = target.value ?? asOfValue;
  if (targetTime.getTime() > asOfValue.getTime()) {
    return {
      ok: false,
      error:
        "INVALID_TARGET: `targetTime` liegt nach `asOf` — eine Abfrage darf keine Zukunft als Zielzeit " +
        "verwenden (genau das wäre Look-ahead).",
    };
  }
  const rows = entities.items.length * features.length;
  if (rows > FEATURE_LIMITS.pitRows) {
    return {
      ok: false,
      error: `LIMIT_ROWS: ${rows} (Entities × Features) überschreitet die harte Grenze ${FEATURE_LIMITS.pitRows}.`,
    };
  }
  return { ok: true, request: { asOf: asOfValue, entities: entities.items, features, timeframe, targetTime } };
}

/** Bildet die Anfrage auf die zu ladenden Definitionsreferenzen ab. */
export function refsOf(request: PitQueryRequest, registry: FeatureRegistry): readonly FeatureRef[] {
  return request.features.map((spec) => {
    const def = registry.require(spec);
    return { featureId: def.featureId, version: def.version };
  });
}

function tieBreak(a: FeatureValueRow, b: FeatureValueRow): FeatureValueRow {
  if (a.eventTime.getTime() !== b.eventTime.getTime()) {
    return a.eventTime.getTime() > b.eventTime.getTime() ? a : b;
  }
  if (a.availableAt.getTime() !== b.availableAt.getTime()) {
    return a.availableAt.getTime() > b.availableAt.getTime() ? a : b;
  }
  return a.valueHash > b.valueHash ? a : b;
}

/**
 * Führt den Point-in-Time-Join über bereits geladene Zeilen aus.
 *
 * Rein und damit direkt testbar (synthetischer Leakage-Test: eine verspätete
 * Quelle ist vor ihrem `available_at` unsichtbar). Die Ladelogik (SQL, Indizes,
 * Limits) liegt im {@link PitSource}.
 *
 * @throws {FeatureStoreError} `FEATURE_UNKNOWN`, wenn eine angefragte
 *   Definition nicht registriert ist.
 */
export function pointInTimeJoin(
  rows: readonly FeatureValueRow[],
  request: PitQueryRequest,
  registry: FeatureRegistry,
  opts: { maxLagMs?: number } = {}
): FeaturePitResult {
  const specs = request.features.map((spec) => registry.require(spec));
  const asOfMs = request.asOf.getTime();
  const targetMs = request.targetTime.getTime();

  // Zulässige Zeilen vorfiltern (die einzige Look-ahead-Regel des Moduls).
  const eligible = rows.filter((row) => row.eventTime.getTime() <= targetMs && row.availableAt.getTime() <= asOfMs);
  const best = new Map<string, FeatureValueRow>();
  for (const row of eligible) {
    const key = `${row.entityId}\u0000${row.featureId}\u0000${row.featureVersion}`;
    const current = best.get(key);
    best.set(key, current ? tieBreak(current, row) : row);
  }

  const values: FeaturePitValue[] = [];
  let matched = 0;
  let missing = 0;
  let nullValues = 0;
  let stale = 0;
  for (const entityId of request.entities) {
    for (const def of specs) {
      const row = best.get(`${entityId}\u0000${def.featureId}\u0000${def.version}`);
      if (!row) {
        missing += 1;
        values.push({
          entityId,
          featureId: def.featureId,
          version: def.version,
          dtype: def.dtype,
          unit: def.unit,
          status: "MISSING",
          value: null,
          nullReason: null,
          qualityStatus: null,
          eventTime: null,
          availableAt: null,
          computedAt: null,
          lagMs: null,
          stale: false,
          definitionHash: null,
        });
        continue;
      }
      matched += 1;
      // Informationsalter: wie alt ist das JÜNGSTE, was ich über diesen Wert
      // weiß? Ein erst spät eingetroffener Wert ist frisch — eine Reihe, die
      // seit Tagen nicht mehr aktualisiert wurde, ist es nicht.
      const lagMs = asOfMs - Math.max(row.eventTime.getTime(), row.availableAt.getTime());
      const maxLag = opts.maxLagMs ?? SUPPORTED_TIMEFRAME_MS[request.timeframe];
      const isStale = lagMs > maxLag;
      if (isStale) stale += 1;
      const status: FeaturePitStatus = row.value === null ? "NULL_VALUE" : "OK";
      if (status === "NULL_VALUE") nullValues += 1;
      values.push({
        entityId,
        featureId: def.featureId,
        version: def.version,
        dtype: def.dtype as FeatureDtype,
        unit: def.unit,
        status,
        value: row.value,
        nullReason: row.nullReason,
        qualityStatus: row.qualityStatus as FeatureQualityStatus,
        eventTime: row.eventTime.toISOString(),
        availableAt: row.availableAt.toISOString(),
        computedAt: row.computedAt.toISOString(),
        lagMs,
        stale: isStale,
        definitionHash: row.definitionHash,
      });
    }
  }

  return {
    asOf: request.asOf.toISOString(),
    timeframe: request.timeframe,
    values,
    requested: values.length,
    matched,
    missing,
    nullValues,
    stale,
  };
}

/**
 * Liest die für eine PIT-Anfrage nötigen Rohzeilen über eine {@link PitSource}
 * und führt den Join aus.
 *
 * Das Ladevolumen ist hart begrenzt (`FEATURE_LIMITS.pitSourceRows`); wird die
 * Grenze erreicht, ist die Antwort unvollständig — sie wird deshalb **nicht**
 * stillschweigend gekürzt, sondern als `FEATURE_PIT_SOURCE_TRUNCATED`
 * abgelehnt (eine teilweise Menge würde als „Wert fehlt“ fehlinterpretiert).
 */
export async function runPitQuery(
  request: PitQueryRequest,
  source: PitSource,
  registry: FeatureRegistry,
  opts: { maxLagMs?: number; sourceLimit?: number } = {}
): Promise<FeaturePitResult> {
  const refs = refsOf(request, registry);
  const limit = opts.sourceLimit ?? FEATURE_LIMITS.pitSourceRows;
  const rows = await source.readValues({
    entities: request.entities,
    refs,
    timeframe: request.timeframe,
    asOf: request.asOf,
    targetTime: request.targetTime,
    limit,
  });
  if (rows.length >= limit) {
    throw new FeatureStoreError(
      "FEATURE_PIT_SOURCE_TRUNCATED",
      `Die PIT-Abfrage hat die Quellgrenze von ${limit} Zeilen erreicht. ` +
        "Zeitraum/Entities eingrenzen (die Antwort wäre sonst unvollständig).",
      { limit }
    );
  }
  return pointInTimeJoin(rows, request, registry, opts);
}
