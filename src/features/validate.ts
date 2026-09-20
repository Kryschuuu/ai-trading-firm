/**
 * Fail-closed Validierung von Featuredefinitionen und -werten (RMA-P6-01).
 *
 * Die Prüfungen stehen **eine** Stelle weit vor der Persistenz: eine ungültige
 * Definition oder ein Wert mit falschem Typ/Semantik darf nie in die Datenbank
 * gelangen — auch nicht über einen Direktaufruf am Service vorbei. Alle Fehler
 * sind `FeatureStoreError` mit stabilem Code:
 *
 * | Code                          | Bedeutung                                                   |
 * | ----------------------------- | ----------------------------------------------------------- |
 * | `FEATURE_DEFINITION_INVALID`  | Definition verletzt Form/Semantik (Pflicht, Muster, Bereich) |
 * | `FEATURE_VALUE_INVALID`       | Wertzeile verletzt Typ-/Zeit-/NULL-Invarianten               |
 * | `FEATURE_DEFINITION_IMMUTABLE`| gleiche Version, anderer Fingerprint (Registry/Store)        |
 */
import {
  FEATURE_CONFIG_KEY_PATTERN,
  FEATURE_DTYPES,
  FEATURE_ENUM_VALUE_PATTERN,
  FEATURE_HASH_PATTERN,
  FEATURE_ID_PATTERN,
  FEATURE_LIMITS,
  FEATURE_NULL_REASONS,
  FeatureStoreError,
  isFeatureDtype,
  type FeatureDefinition,
  type FeatureDefinitionInput,
  type FeatureNullReason,
  type FeatureValueDraft,
} from "./types";
import { SUPPORTED_TIMEFRAMES } from "../lib/marketdata/historicalStore";

/** Prüft eine Deklaration; wirft `FEATURE_DEFINITION_INVALID` bei Verstoß. */
export function assertValidDefinition(input: FeatureDefinitionInput): void {
  // Explizite Typannotation: nur so erkennt TypeScript den Aufruf als
  // „kehrt nie zurück“ und schließt die Prüfungen darunter ab (fail-closed
  // Validierung ohne `as`-Casts).
  const fail: (message: string, detail?: Record<string, unknown>) => never = (message, detail) => {
    throw new FeatureStoreError("FEATURE_DEFINITION_INVALID", message, {
      featureId: typeof input.featureId === "string" ? input.featureId.slice(0, FEATURE_LIMITS.featureIdLength) : undefined,
      version: input.version,
      ...detail,
    });
  };

  if (typeof input.featureId !== "string" || input.featureId.length > FEATURE_LIMITS.featureIdLength) {
    fail(`featureId fehlt oder ist länger als ${FEATURE_LIMITS.featureIdLength} Zeichen.`);
  }
  if (!FEATURE_ID_PATTERN.test(input.featureId)) {
    fail(`featureId "${String(input.featureId).slice(0, 64)}" entspricht nicht dem Muster "namespace.name" (Kleinschreibung/Punkte).`);
  }
  if (!Number.isInteger(input.version) || input.version < 1 || input.version > 100_000) {
    fail("version muss eine ganze Zahl ≥ 1 sein (neue Semantik ⇒ neue Version).");
  }
  if (typeof input.label !== "string" || input.label.trim() === "" || input.label.length > 120) {
    fail("label ist Pflicht (1..120 Zeichen).");
  }
  if (typeof input.description !== "string" || input.description.trim().length < 20) {
    fail("description ist Pflicht und muss die Semantik erklären (mindestens 20 Zeichen).");
  }
  if (!isFeatureDtype(input.dtype)) {
    fail(`dtype "${String(input.dtype)}" ist nicht erlaubt (${FEATURE_DTYPES.join(", ")}).`);
  }
  if (!(SUPPORTED_TIMEFRAMES as readonly string[]).includes(input.timeframe)) {
    fail(`timeframe "${String(input.timeframe)}" ist nicht in der Allowlist.`);
  }
  if (input.entityType !== "instrument") {
    fail(`entityType "${String(input.entityType)}" wird (noch) nicht unterstützt.`);
  }
  if (!Number.isInteger(input.lookbackBars) || input.lookbackBars < 1 || input.lookbackBars > 10_000) {
    fail("lookbackBars muss eine ganze Zahl in 1..10000 sein.");
  }
  if (typeof input.computeKey !== "string" || input.computeKey.trim() === "" || input.computeKey.length > 80) {
    fail("computeKey ist Pflicht (1..80 Zeichen).");
  }
  if (typeof input.owner !== "string" || input.owner.trim() === "" || input.owner.length > 60) {
    fail("owner ist Pflicht (1..60 Zeichen) — ein Feature ohne Verantwortlichen ist nicht betreibbar.");
  }

  if (input.dtype === "enum") {
    const values = input.enumValues;
    if (values === null || !Array.isArray(values) || values.length < 2 || values.length > 32) {
      fail("enum-Features brauchen 2..32 erlaubte Werte in enumValues.");
    }
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string" || !FEATURE_ENUM_VALUE_PATTERN.test(value)) {
        fail(`enum-Wert "${String(value).slice(0, 32)}" entspricht nicht dem Muster [A-Z][A-Z0-9_]*.`);
      }
      if (seen.has(value)) fail(`enum-Wert "${value}" ist doppelt deklariert.`);
      seen.add(value);
    }
    if (input.unit !== null) fail("enum-Features dürfen keine Einheit deklarieren (unit muss null sein).");
    if (input.valueDecimals !== null) fail("enum-Features dürfen keine Rundung deklarieren (valueDecimals muss null sein).");
  } else if (input.enumValues !== null) {
    fail("enumValues ist nur bei dtype \"enum\" erlaubt (sonst null).");
  }

  if (input.dtype === "number") {
    if (typeof input.unit !== "string" || input.unit.trim() === "" || input.unit.length > 40) {
      fail("number-Features brauchen eine Einheit (unit, 1..40 Zeichen) — ohne Einheit ist der Wert nicht interpretierbar.");
    }
    if (!Number.isInteger(input.valueDecimals) || (input.valueDecimals as number) < 0 || (input.valueDecimals as number) > 12) {
      fail("number-Features brauchen valueDecimals (ganze Zahl 0..12).");
    }
  } else if (input.unit !== null && input.unit !== undefined) {
    fail(`${input.dtype}-Features dürfen keine Einheit deklarieren (unit muss null sein).`);
  }

  if (!Array.isArray(input.dependencies)) fail("dependencies muss eine Liste sein (leer erlaubt).");
  const depKeys = new Set<string>();
  for (const dep of input.dependencies) {
    if (typeof dep?.featureId !== "string" || !Number.isInteger(dep?.version) || dep.version < 1) {
      fail("dependencies brauchen featureId und version (≥ 1).");
    }
    if (!FEATURE_ID_PATTERN.test(dep.featureId)) fail(`Abhängigkeit "${String(dep.featureId).slice(0, 64)}" hat keine gültige Feature-ID.`);
    const key = `${dep.featureId}@${dep.version}`;
    if (depKeys.has(key)) fail(`Abhängigkeit ${key} ist doppelt deklariert.`);
    depKeys.add(key);
    if (key === `${input.featureId}@${input.version}`) fail("Ein Feature darf nicht von sich selbst abhängen.");
  }

  if (input.config === null || typeof input.config !== "object" || Array.isArray(input.config)) {
    fail("config muss ein Objekt mit skalaren Werten sein (kein Blob).");
  }
  const entries = Object.entries(input.config);
  if (entries.length > 32) fail("config hat zu viele Einträge (max. 32).");
  for (const [key, value] of entries) {
    if (!FEATURE_CONFIG_KEY_PATTERN.test(key)) fail(`config-Schlüssel "${String(key).slice(0, 64)}" entspricht nicht dem Muster [a-z][A-Za-z0-9_]*.`);
    const ok = value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
    if (!ok) fail(`config-Wert für "${key}" muss ein endlicher Skalar (oder null) sein.`);
  }
}

/**
 * Prüft eine Wertezeile gegen ihre Definition (fail-closed).
 *
 * Geprüft werden Dtype-Übereinstimmung, Enum-Zugehörigkeit, Endlichkeit der
 * Zahl, `availableAt ≥ eventTime`, `computedAt ≥ availableAt` sowie die
 * NULL-Invariante: **entweder** Wert **oder** Null-Grund, nie beides und nie
 * keins. Eine Zeile, die eine dieser Invarianten verletzt, darf nie geschrieben
 * werden — `null` wird insbesondere nie zu `0`.
 */
export function assertValueMatchesDefinition(draft: FeatureValueDraft, definition: FeatureDefinition): void {
  const fail: (message: string) => never = (message) => {
    throw new FeatureStoreError("FEATURE_VALUE_INVALID", message, {
      featureId: draft.featureId,
      version: draft.featureVersion,
      entityId: draft.entityId.slice(0, FEATURE_LIMITS.entityIdLength),
      eventTime: draft.eventTime.toISOString(),
    });
  };

  if (draft.featureId !== definition.featureId || draft.featureVersion !== definition.version) {
    fail("Wertzeile und Definition gehören nicht zusammen (featureId/version).");
  }
  if (draft.dtype !== definition.dtype) fail(`dtype "${draft.dtype}" ≠ Definition "${definition.dtype}".`);
  if (draft.definitionHash !== definition.definitionHash) {
    fail("definitionHash der Zeile weicht vom Definitions-Fingerprint ab.");
  }
  if (draft.timeframe !== definition.timeframe) fail(`timeframe "${draft.timeframe}" ≠ Definition "${definition.timeframe}".`);
  if (!(draft.eventTime instanceof Date) || !Number.isFinite(draft.eventTime.getTime())) {
    fail("eventTime ist kein gültiger Zeitpunkt.");
  }
  if (!(draft.availableAt instanceof Date) || !Number.isFinite(draft.availableAt.getTime())) {
    fail("availableAt ist kein gültiger Zeitpunkt.");
  }
  if (!(draft.computedAt instanceof Date) || !Number.isFinite(draft.computedAt.getTime())) {
    fail("computedAt ist kein gültiger Zeitpunkt.");
  }
  if (draft.availableAt.getTime() < draft.eventTime.getTime()) {
    fail("availableAt darf nicht vor eventTime liegen (Look-ahead).");
  }
  if (draft.computedAt.getTime() < draft.availableAt.getTime()) {
    fail("computedAt darf nicht vor availableAt liegen (Wert vor der Bekanntheit berechnet).");
  }
  const hasValue = draft.value !== null;
  const hasReason = draft.nullReason !== null;
  if (hasValue === hasReason) {
    fail(
      hasValue
        ? "Wertzeile trägt Wert UND Null-Grund — genau eines ist zulässig."
        : "Wertzeile trägt weder Wert noch Null-Grund (unbekannt muss begründet sein)."
    );
  }
  if (hasReason && !(FEATURE_NULL_REASONS as readonly string[]).includes(draft.nullReason as FeatureNullReason)) {
    fail(`nullReason "${String(draft.nullReason)}" ist nicht in der Allowlist.`);
  }
  if (hasValue) {
    switch (definition.dtype) {
      case "number":
        if (typeof draft.value !== "number" || !Number.isFinite(draft.value)) {
          fail("number-Feature mit nicht-endlichem/nicht-numerischem Wert.");
        }
        break;
      case "boolean":
        if (typeof draft.value !== "boolean") fail("boolean-Feature mit nicht-boolean Wert.");
        break;
      case "enum": {
        const allowed = definition.enumValues ?? [];
        if (typeof draft.value !== "string" || !allowed.includes(draft.value)) {
          fail(`enum-Feature mit Wert außerhalb der Allowlist (${allowed.join(", ")}).`);
        }
        break;
      }
      default:
        fail(`unbekannter dtype "${String(definition.dtype)}".`);
    }
  }
  if (!FEATURE_HASH_PATTERN.test(draft.valueHash)) fail("valueHash entspricht nicht dem Fingerprint-Muster.");
  if (!FEATURE_HASH_PATTERN.test(draft.sourceManifest.datasetHash)) {
    fail("sourceManifest.datasetHash entspricht nicht dem Fingerprint-Muster.");
  }
  if (draft.sourceManifest.candleCount < definition.lookbackBars && draft.value !== null) {
    fail("Wert mit weniger Kerzen als der deklarierte Lookback — Lookback-Verletzung.");
  }
}
