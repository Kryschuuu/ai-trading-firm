/**
 * Point-in-Time Feature Store — Testsuite (RMA-P6-01, v1.53.0).
 *
 * Deckung (Definition of Done):
 *   1. Registry: Immutabilität (gleiche Version + andere Semantik ⇒ Fehler,
 *      neue Version ⇒ erlaubt), topologische Ordnung inkl. Abhängigkeits-
 *      verschluss, fail-closed Verweise (unbekanntes Feature, toter
 *      `computeKey`, fehlende Abhängigkeit, Zyklus), Deckungsgleichheit der
 *      Parameter mit den Scanner-Defaults.
 *   2. Formelparität: Featurewerte sind die Scanner-Faktorformeln
 *      (`computeRsi`/`computeAtrPct`) auf demselben Fenster — keine zweite
 *      Implementierung.
 *   3. Wertmodell/Fail-closed: `null` ≠ `0`, genau Wert ODER Null-Grund,
 *      `availableAt ≥ eventTime`, Abhängigkeits-NULL wird nicht geraten.
 *   4. Materialisierung: deterministisch, bounded gebatcht, Cursor-Neustart
 *      ohne Lücke/Duplikat, idempotenter Retry (Replay), Trockenlauf ohne
 *      Write, Abbruch bei nicht erreichbarer Ablage.
 *   5. **Synthetischer Leakage-Test**: eine verspätet eingetroffene Kerze ist
 *      vor ihrem `available_at` unsichtbar; `event_time <= targetTime` wird
 *      ebenfalls hart geprüft (kein Wert aus der Zukunft).
 *   6. Datenrevision: abweichender Wert zum selben Schlüssel wird
 *      protokolliert, **nicht** überschrieben; der Paritätsjob meldet die
 *      Abweichung mit Grund `DATASET_REVISION`.
 *   7. Offline/Online-Parität: Store-Adapter und Compute-Adapter liefern für
 *      dieselbe Anfrage denselben Wert.
 *   8. Betrieb: Coverage/Lag/Revisionszähler, unregistrierte Store-Reihen
 *      sichtbar, Retention wertfreier Manifeste, Metriken ohne Entity-Labels.
 *
 * Die DB-Variante (Constraints, Transaktion, Indizes, Audit-Events) läuft in
 * `tests/featureStore.db.test.ts` und überspringt sich ohne Postgres.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FEATURE_EXECUTORS,
  FEATURE_LIMITS,
  FEATURE_QUALITY_SEVERITY,
  FEATURE_SLICE_DEFAULTS,
  FeatureRegistry,
  FeatureStoreError,
  assertValueMatchesDefinition,
  atrBandOf,
  barCloseTime,
  createComputeBackedSource,
  createSliceRegistry,
  createStoreBackedSource,
  featureStoreStatus,
  featureValueHash,
  getSliceRegistry,
  materializationRunKey,
  materializeSlice,
  parityCheck,
  pitQuery,
  planMaterialization,
  qualityStatusForWindow,
  runPitQuery,
  sliceDefinitions,
  validatePitQuery,
  windowQualityStatus,
  type FeatureBarInput,
  type FeatureCursor,
  type FeatureDefinitionInput,
  type FeatureQualityStatus,
  type FeatureValueDraft,
  type FeatureValueRow,
  type PitSource,
} from "../src/features";
import { draftToInsert } from "../src/features/store";
import { findingsForSeries } from "../src/features/sourceQuality";
import { FeatureMemoryStore } from "./helpers/featureStoreMemory";
import { DEFAULT_SCANNER_CONFIG } from "../src/scanner/config";
import { computeAtrPct } from "../src/scanner/factors/atr";
import { computeRsi } from "../src/scanner/factors/rsi";
import { roundTo } from "../src/scanner/math";
import {
  DEFAULT_ANALYSIS_TIMEFRAME,
  SUPPORTED_TIMEFRAME_MS,
  type SupportedTimeframe,
} from "../src/lib/marketdata/historicalStore";
import { telemetry } from "../src/lib/telemetry";

// ── Fixtures (vollständig deterministisch, keine Uhr, kein Zufall) ──────────

const TF: SupportedTimeframe = DEFAULT_ANALYSIS_TIMEFRAME;
const HOUR = SUPPORTED_TIMEFRAME_MS[TF];
const MINUTE = 60_000;
/** Montag, 2026-09-07T00:00:00Z — fester Bezugspunkt aller Zeitrechnungen. */
const T0 = Date.parse("2026-09-07T00:00:00.000Z");
/** Injizierter Berechnungszeitpunkt (nach allen Ingestion-Zeitpunkten). */
const COMPUTED_AT = new Date(T0 + 80 * HOUR);
const ENTITY = "SIM:BTCUSDT";
const ENTITY_B = "SIM:ETHUSDT";
const RSI = "scanner.rsi";
const ATR = "scanner.atr";
const BAND = "scanner.atr_band";

const SLICE_REFS = [
  { featureId: RSI, version: 1 },
  { featureId: ATR, version: 1 },
  { featureId: BAND, version: 1 },
] as const;

/** Schlusszeit der Kerze `index`(= Eventzeit des daraus abgeleiteten Werts). */
function closeOf(index: number): number {
  return T0 + (index + 1) * HOUR;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Eine Kerze mit deterministischem Kursverlauf.
 *
 * `fetchedAt` ist standardmäßig „kurz nach Schluss“ (schnelle Ingestion).
 * Tests, die eine verspätete Kerze brauchen, setzen `fetchedAtMs` explizit.
 */
function bar(index: number, opts: { close?: number; fetchedAtMs?: number } = {}): FeatureBarInput {
  const time = T0 + index * HOUR;
  const close = opts.close ?? 100 + index * 0.5 + Math.sin(index) * 4;
  return {
    time,
    open: close - 0.4,
    high: close + 1.2,
    low: close - 1.1,
    close,
    volume: 1000 + index * 7,
    fetchedAt: iso(opts.fetchedAtMs ?? closeOf(index) + MINUTE),
  };
}

function series(count: number, mutate?: (bar_: FeatureBarInput, index: number) => FeatureBarInput): FeatureBarInput[] {
  const out: FeatureBarInput[] = [];
  for (let i = 0; i < count; i++) {
    const base = bar(i);
    out.push(mutate ? mutate(base, i) : base);
  }
  return out;
}

/** Fortlaufender Run-Zähler (deterministische Run-IDs über alle Aufrufe). */
let runCounter = 0;

async function materialize(
  store: FeatureMemoryStore,
  input: {
    bars: readonly FeatureBarInput[];
    asOf: Date;
    policy: "bar_close" | "ingested";
    entities?: readonly string[];
    refs?: readonly { featureId: string; version: number }[];
    batchRows?: number;
    maxBatches?: number;
    dryRun?: boolean;
    qualityForBar?: (entityId: string, eventTimeMs: number) => FeatureQualityStatus;
    registry?: FeatureRegistry;
    /** Rohkerzen je Entity (Default: dieselbe Reihe für alle Entities). */
    barsFor?: (entityId: string) => readonly FeatureBarInput[];
  }
) {
  return materializeSlice(
    {
      refs: input.refs ?? SLICE_REFS,
      entities: input.entities ?? [ENTITY],
      timeframe: TF,
      barsFor: input.barsFor ?? (() => input.bars),
      asOf: input.asOf,
      availabilityPolicy: input.policy,
      mode: "INCREMENTAL",
      batchRows: input.batchRows,
      maxBatches: input.maxBatches,
      dryRun: input.dryRun,
      qualityForBar: input.qualityForBar,
    },
    {
      store,
      registry: input.registry,
      now: () => COMPUTED_AT,
      newRunId: () => `run-${String(++runCounter).padStart(3, "0")}`,
      codeVersion: "1.53.0-test",
    }
  );
}

async function query(
  store: FeatureMemoryStore,
  args: { asOf: number; targetTime: number; features?: string; entities?: string; registry?: FeatureRegistry; maxLagMs?: number }
) {
  const checked = validatePitQuery({
    asOf: iso(args.asOf),
    targetTime: iso(args.targetTime),
    entities: args.entities ?? ENTITY,
    features: args.features ?? `${RSI},${ATR},${BAND}`,
    timeframe: TF,
  });
  if (!checked.ok) assert.fail(`PIT-Anfrage ungültig: ${checked.error}`);
  return pitQuery(checked.request, { store, registry: args.registry, maxLagMs: args.maxLagMs });
}

function row(result: Awaited<ReturnType<typeof pitQuery>>, featureId: string, entityId = ENTITY) {
  const found = result.values.find((v) => v.featureId === featureId && v.entityId === entityId);
  assert.ok(found, `PIT-Antwort enthält ${featureId} für ${entityId} nicht`);
  return found;
}

function expectStoreError(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof FeatureStoreError, `erwartet FeatureStoreError, erhalten ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Registry & Immutabilität
// ─────────────────────────────────────────────────────────────────────────────

describe("featureStore: Registry", () => {
  it("Slice-Registry ist stabil, topologisch sortiert und deckungsgleich mit den Scanner-Defaults", () => {
    const registry = getSliceRegistry();
    assert.equal(registry, getSliceRegistry(), "Registry muss prozessweit stabil (lazy singleton) sein");

    assert.deepEqual(
      registry.definitions().map((def) => `${def.featureId}@${def.version}`),
      [`${ATR}@1`, `${BAND}@1`, `${RSI}@1`]
    );
    assert.deepEqual(
      registry.topoOrder([{ featureId: BAND, version: 1 }]).map((def) => def.featureId),
      [ATR, BAND],
      "Abhängigkeiten müssen vor ihren Konsumenten kommen"
    );

    const rsi = registry.require({ featureId: RSI, version: 1 });
    const atr = registry.require({ featureId: ATR, version: 1 });
    const band = registry.require({ featureId: BAND, version: 1 });

    // Parameter = Scanner-Defaults (Drift wird hier zum Testfehler, nicht zu
    // einem stillen Semantikwechsel im Store).
    assert.equal(FEATURE_SLICE_DEFAULTS.rsiPeriod, DEFAULT_SCANNER_CONFIG.factors.rsi.period);
    assert.equal(FEATURE_SLICE_DEFAULTS.atrPeriod, DEFAULT_SCANNER_CONFIG.factors.atr.period);
    assert.equal(FEATURE_SLICE_DEFAULTS.atrBandLow, DEFAULT_SCANNER_CONFIG.factors.atr.idealLowPct);
    assert.equal(FEATURE_SLICE_DEFAULTS.atrBandHigh, DEFAULT_SCANNER_CONFIG.factors.atr.idealHighPct);
    assert.equal(rsi.lookbackBars, DEFAULT_SCANNER_CONFIG.factors.rsi.period + 1);
    assert.equal(atr.lookbackBars, DEFAULT_SCANNER_CONFIG.factors.atr.period + 1);
    assert.equal(rsi.config.period, DEFAULT_SCANNER_CONFIG.factors.rsi.period);
    assert.equal(band.enumValues?.join(","), "LOW,NORMAL,HIGH");
    assert.deepEqual(band.dependencies, [{ featureId: ATR, version: 1 }]);

    // Einheiten sind Teil der Semantik (Doku-Pflicht).
    assert.equal(rsi.unit, "index_0_100");
    assert.equal(atr.unit, "fraction_of_close");
    assert.equal(band.unit, null);
    assert.equal(rsi.owner, "scanner");

    for (const def of registry.definitions()) {
      assert.match(def.definitionHash, /^fd1:[0-9a-f]{64}$/);
      assert.match(def.codeHash, /^fc1:[0-9a-f]{64}$/);
      assert.match(def.configHash, /^fg1:[0-9a-f]{64}$/);
      assert.ok(Object.isFrozen(def) && Object.isFrozen(def.config) && Object.isFrozen(def.dependencies));
    }
  });

  it("Definitionen sind unveränderlich: gleiche Version + andere Semantik ⇒ Fehler, neue Version ⇒ erlaubt", () => {
    const [rsi, atr, band] = sliceDefinitions();

    // 1) Reine Wiederholung derselben Deklaration ist idempotent.
    const doubled = FeatureRegistry.create([rsi, rsi], FEATURE_EXECUTORS);
    assert.equal(doubled.definitions().length, 1);

    // 2) Gleiche (featureId, version) mit geänderter Einheit ⇒ Konflikt.
    const mutated: FeatureDefinitionInput = { ...rsi, unit: "percent_0_100" };
    expectStoreError(() => FeatureRegistry.create([rsi, mutated], FEATURE_EXECUTORS), "FEATURE_DEFINITION_IMMUTABLE");

    // 3) Neue Version mit neuer Semantik ist erlaubt (und bekommt einen
    //    anderen Fingerprint) — genau der dokumentierte Migrationspfad.
    const v2: FeatureDefinitionInput = { ...mutated, version: 2 };
    const withV2 = FeatureRegistry.create([rsi, v2], FEATURE_EXECUTORS);
    assert.notEqual(
      withV2.require({ featureId: RSI, version: 1 }).definitionHash,
      withV2.require({ featureId: RSI, version: 2 }).definitionHash
    );

    // 4) Geänderte Konfiguration ⇒ anderer Config-/Definitions-Hash.
    const otherConfig = FeatureRegistry.create(sliceDefinitions({ ...FEATURE_SLICE_DEFAULTS, rsiPeriod: 21 }), FEATURE_EXECUTORS);
    assert.notEqual(
      otherConfig.require({ featureId: RSI, version: 1 }).configHash,
      getSliceRegistry().require({ featureId: RSI, version: 1 }).configHash
    );

    // 5) Ungültige Deklarationen werden fail-closed abgewiesen.
    expectStoreError(() => FeatureRegistry.create([{ ...rsi, dtype: "json" as never }], FEATURE_EXECUTORS), "FEATURE_DEFINITION_INVALID");
    expectStoreError(() => FeatureRegistry.create([{ ...rsi, owner: "" }], FEATURE_EXECUTORS), "FEATURE_DEFINITION_INVALID");
    expectStoreError(() => FeatureRegistry.create([{ ...rsi, enumValues: ["LOW"] }], FEATURE_EXECUTORS), "FEATURE_DEFINITION_INVALID");
    expectStoreError(() => FeatureRegistry.create([{ ...rsi, computeKey: "scanner.gibt_es_nicht@1" }], FEATURE_EXECUTORS), "FEATURE_EXECUTOR_MISSING");
    expectStoreError(
      () => FeatureRegistry.create([rsi, { ...band, dependencies: [{ featureId: "scanner.fehlt", version: 1 }] }], FEATURE_EXECUTORS),
      "FEATURE_DEPENDENCY_MISSING"
    );
    expectStoreError(
      () =>
        FeatureRegistry.create(
          [
            { ...rsi, featureId: "scanner.a", dependencies: [{ featureId: "scanner.b", version: 1 }] },
            { ...atr, featureId: "scanner.b", dependencies: [{ featureId: "scanner.a", version: 1 }] },
          ],
          FEATURE_EXECUTORS
        ),
      "FEATURE_DEPENDENCY_CYCLE"
    );
    expectStoreError(() => getSliceRegistry().require({ featureId: "scanner.unbekannt", version: 1 }), "FEATURE_UNKNOWN");
    expectStoreError(() => createSliceRegistry().topoOrder([{ featureId: "scanner.unbekannt", version: 1 }]), "FEATURE_UNKNOWN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Formelparität & Wertmodell
// ─────────────────────────────────────────────────────────────────────────────

describe("featureStore: Wertmodell und Formeln", () => {
  const bars = series(30);

  it("Featurewerte sind exakt die Scanner-Faktorformeln (keine Zweitformel)", () => {
    const registry = getSliceRegistry();
    const plan = planMaterialization({
      registry,
      refs: SLICE_REFS,
      entityId: ENTITY,
      timeframe: TF,
      bars,
      asOf: closeOf(29),
      availabilityPolicy: "ingested",
      computedAt: COMPUTED_AT,
      maxRows: 1000,
    });

    const last = (featureId: string) => {
      const drafts = plan.drafts.filter((d) => d.featureId === featureId);
      assert.ok(drafts.length > 0);
      return drafts[drafts.length - 1];
    };
    const rsiWindow = bars.slice(bars.length - (DEFAULT_SCANNER_CONFIG.factors.rsi.period + 1));
    const atrWindow = bars.slice(bars.length - (DEFAULT_SCANNER_CONFIG.factors.atr.period + 1));
    const closes = rsiWindow.map((b) => b.close);
    const rsiDraft = last(RSI);
    const atrDraft = last(ATR);
    const bandDraft = last(BAND);

    assert.equal(rsiDraft.value, roundTo(computeRsi(closes, DEFAULT_SCANNER_CONFIG.factors.rsi.period) as number, 4));
    assert.equal(atrDraft.value, roundTo(computeAtrPct(atrWindow, DEFAULT_SCANNER_CONFIG.factors.atr.period) as number, 6));
    assert.equal(
      bandDraft.value,
      atrBandOf(atrDraft.value as number, { low: FEATURE_SLICE_DEFAULTS.atrBandLow, high: FEATURE_SLICE_DEFAULTS.atrBandHigh })
    );

    // Jeder Draft erfüllt die Wertinvarianten (inkl. `availableAt ≥ eventTime`).
    for (const draft of plan.drafts) {
      assertValueMatchesDefinition(draft, registry.require({ featureId: draft.featureId, version: draft.featureVersion }));
    }
    assert.match(rsiDraft.valueHash, /^fv1:[0-9a-f]{64}$/);
    assert.equal(rsiDraft.eventTime.toISOString(), iso(closeOf(29)));
    assert.equal(rsiDraft.sourceManifest.candleCount, DEFAULT_SCANNER_CONFIG.factors.rsi.period + 1);
    assert.equal(rsiDraft.sourceManifest.availabilityPolicy, "ingested");
  });

  it("Fail-closed: zu wenig Historie und unbrauchbare Kurse ergeben NULL mit Grund — nie 0", () => {
    const registry = getSliceRegistry();
    const planFor = (input: readonly FeatureBarInput[], barIndex: number) => {
      const plan = planMaterialization({
        registry,
        refs: [{ featureId: RSI, version: 1 }],
        entityId: ENTITY,
        timeframe: TF,
        bars: input,
        asOf: closeOf(barIndex),
        availabilityPolicy: "ingested",
        computedAt: COMPUTED_AT,
        maxRows: 1000,
      });
      return plan.drafts.find((d) => d.featureId === RSI);
    };

    // Zu kurze Reihe (10 Bars < 15 Lookback): NULL mit Begründung.
    const short = series(10);
    const tooShort = planFor(short, 9);
    assert.ok(tooShort);
    assert.equal(tooShort.value, null);
    assert.equal(tooShort.nullReason, "INSUFFICIENT_LOOKBACK");
    assert.notEqual(tooShort.value, 0);

    // Unbrauchbarer Kurs (close ≤ 0) ⇒ INVALID_INPUT, kein geratener Wert.
    const broken = series(30, (b, i) => (i === 29 ? { ...b, close: 0, low: 0, high: 0.5 } : b));
    const invalid = planFor(broken, 29);
    assert.ok(invalid);
    assert.equal(invalid.value, null);
    assert.equal(invalid.nullReason, "INVALID_INPUT");
  });

  it("Abhängigkeit wird nicht geraten: NULL-ATR ⇒ NULL-Band mit Grund DEPENDENCY_NULL", () => {
    const registry = getSliceRegistry();
    const broken = series(30, (b, i) => (i === 29 ? { ...b, close: 0, low: 0, high: 0.5 } : b));
    const plan = planMaterialization({
      registry,
      refs: [{ featureId: BAND, version: 1 }],
      entityId: ENTITY,
      timeframe: TF,
      bars: broken,
      asOf: closeOf(29),
      availabilityPolicy: "ingested",
      computedAt: COMPUTED_AT,
      maxRows: 1000,
    });
    const atrDraft = plan.drafts.find((d) => d.featureId === ATR && d.eventTime.getTime() === closeOf(29));
    const bandDraft = plan.drafts.find((d) => d.featureId === BAND && d.eventTime.getTime() === closeOf(29));
    assert.ok(atrDraft && bandDraft, "Abhängigkeit muss automatisch mitschrieben werden");
    assert.equal(atrDraft.value, null);
    assert.equal(bandDraft.value, null);
    assert.equal(bandDraft.nullReason, "DEPENDENCY_NULL", "kein „neutrales“ LOW als Ersatzwert");
  });

  it("Wertregeln werden erzwungen: genau Wert ODER Null-Grund, Enum-Allowlist, Zeitordnung", () => {
    const registry = getSliceRegistry();
    const rsi = registry.require({ featureId: RSI, version: 1 });
    const band = registry.require({ featureId: BAND, version: 1 });
    const manifest = {
      source: "historical-store",
      candleCount: rsi.lookbackBars,
      firstEventTime: iso(closeOf(20) - rsi.lookbackBars * HOUR),
      lastEventTime: iso(closeOf(20)),
      maxIngestedAt: iso(closeOf(20)),
      datasetHash: "ds1:" + "0".repeat(64),
      availabilityPolicy: "ingested" as const,
    };
    const draftOf = (overrides: Partial<FeatureValueDraft> = {}): FeatureValueDraft => {
      const draft = {
        featureId: RSI,
        featureVersion: 1,
        entityType: "instrument",
        entityId: ENTITY,
        timeframe: TF,
        dtype: "number",
        eventTime: new Date(closeOf(20)),
        availableAt: new Date(closeOf(20)),
        computedAt: COMPUTED_AT,
        value: 55.5,
        nullReason: null,
        qualityStatus: "OK",
        definitionHash: rsi.definitionHash,
        valueHash: "fv1:" + "0".repeat(64),
        sourceManifest: manifest,
        ...overrides,
      } as FeatureValueDraft;
      draft.valueHash = featureValueHash(draft);
      return draft;
    };
    const base = draftOf();
    assert.doesNotThrow(() => assertValueMatchesDefinition(base, rsi));

    // 0 als „Ersatzwert für unbekannt“ ist verboten.
    expectStoreError(
      () => assertValueMatchesDefinition({ ...base, value: 0, nullReason: "INSUFFICIENT_LOOKBACK" }, rsi),
      "FEATURE_VALUE_INVALID"
    );
    // Weder Wert noch Grund ist ebenfalls verboten („unbekannt“ muss begründet sein).
    expectStoreError(() => assertValueMatchesDefinition({ ...base, value: null, nullReason: null }, rsi), "FEATURE_VALUE_INVALID");
    // availableAt vor eventTime = Look-ahead.
    expectStoreError(
      () => assertValueMatchesDefinition({ ...base, availableAt: new Date(closeOf(19)) }, rsi),
      "FEATURE_VALUE_INVALID"
    );
    // enum-Wert außerhalb der Allowlist.
    expectStoreError(
      () =>
        assertValueMatchesDefinition(
          draftOf({ featureId: BAND, dtype: "enum", definitionHash: band.definitionHash, value: "SEHR_HOCH" }),
          band
        ),
      "FEATURE_VALUE_INVALID"
    );
    // Persistenz-Abbildung: „Wert und Grund gleichzeitig“ bzw. „keins von beiden“ fliegt raus.
    expectStoreError(() => draftToInsert({ ...base, value: null, nullReason: null }, "run-x"), "value:invalid");
    expectStoreError(() => draftToInsert({ ...base, value: 42, nullReason: "MISSING_BARS" }, "run-x"), "value:invalid");
    assert.equal(draftToInsert({ ...base, value: null, nullReason: "MISSING_BARS" }, "run-x").valueNum, null);
    assert.equal(draftToInsert({ ...base, value: null, nullReason: "MISSING_BARS" }, "run-x").nullReason, "MISSING_BARS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Materialisierung: Batching, Cursor, Idempotenz
// ─────────────────────────────────────────────────────────────────────────────

describe("featureStore: Materialisierung", () => {
  const bars = series(30);
  const asOf = new Date(closeOf(29) + 5 * MINUTE);

  it("bounded Batching mit Cursor-Fortsetzung: keine Lücke, kein Duplikat", async () => {
    const store = new FeatureMemoryStore();
    const first = await materialize(store, { bars, asOf, policy: "ingested", batchRows: 15, maxBatches: 1 });
    assert.equal(first.truncated, true, "Batchlimit muss als truncated sichtbar werden");
    assert.equal(first.batches, 1);
    assert.equal(first.valuesWritten, 15);
    assert.ok(first.cursors.every((c) => c.watermarkEventTime <= iso(closeOf(29))));

    const second = await materialize(store, { bars, asOf, policy: "ingested", batchRows: 15, maxBatches: 100 });
    assert.ok(second.skippedBeforeCursor > 0, "der zweite Lauf muss am Cursor fortsetzen");
    assert.equal(second.revisions, 0);

    // 30 Bars × 3 Features, jeder Bar genau einmal.
    assert.equal(store.values.size, 90);
    assert.equal(first.valuesWritten + second.valuesWritten, 90);
    for (const featureId of [RSI, ATR, BAND]) {
      const rows = store.valuesFor(ENTITY, featureId);
      assert.equal(rows.length, 30, `${featureId}: genau ein Wert je Bar`);
      const keys = new Set(rows.map((r) => r.eventTime.getTime()));
      assert.equal(keys.size, 30, `${featureId}: keine doppelte Eventzeit`);
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i].eventTime.getTime() - rows[i - 1].eventTime.getTime() === HOUR, "lückenloses 1h-Raster");
      }
    }
    const cursor = store.cursorOf(RSI, 1, ENTITY, TF);
    assert.ok(cursor);
    assert.equal(cursor.watermarkEventTime.getTime(), closeOf(29));
  });

  it("dieselbe Eingabe ⇒ dieselben Werte (Determinismus); Hashes enthalten kein computedAt", async () => {
    const a = new FeatureMemoryStore();
    const b = new FeatureMemoryStore();
    await materialize(a, { bars, asOf, policy: "ingested" });
    await materialize(b, { bars, asOf, policy: "ingested" });
    const hashes = (store: FeatureMemoryStore) =>
      store
        .rowsFor(ENTITY)
        .map((row) => `${row.featureId}@${row.featureVersion}:${row.eventTime.toISOString()}:${row.valueHash}`);
    assert.deepEqual(hashes(a), hashes(b));

    const rowA = a.valuesFor(ENTITY, RSI)[20];
    const rowB = b.valuesFor(ENTITY, RSI)[20];
    assert.equal(rowA.valueHash, rowB.valueHash);
    assert.equal(rowA.value, rowB.value);
    // Ein späterer, identischer Rechenlauf erzeugt denselben Inhalts-Hash:
    // `computedAt` ist bewusst NICHT Teil des Fingerprints.
    const laterRecalculation = { ...rowA, computedAt: new Date(COMPUTED_AT.getTime() + 3 * HOUR) };
    assert.equal(rowA.valueHash, featureValueHash(laterRecalculation));
  });

  it("idempotenter Retry: gleicher Idempotency-Key ⇒ Replay statt Doppelwrite", async () => {
    const store = new FeatureMemoryStore();
    const first = await materialize(store, { bars, asOf, policy: "ingested" });
    assert.equal(first.runsCreated, 1);
    assert.equal(store.values.size, 90);

    // Cursor-Verlust (frische Replik / verlorener Fortschritt) simuliert den
    // realistischen Retry: derselbe Plan, derselbe Idempotency-Key.
    store.cursors.clear();
    const retry = await materialize(store, { bars, asOf, policy: "ingested" });

    assert.equal(retry.runsReplayed, 1, "der Retry muss als Replay erkannt werden");
    assert.equal(retry.runsCreated, 0);
    assert.equal(retry.valuesWritten, 0);
    assert.equal(retry.duplicates, 90);
    assert.equal(store.values.size, 90, "kein zweiter Wert je Schlüssel");
    assert.equal(store.commits, 1, "kein zweiter Commit");
    assert.equal(store.replays, 1);

    // Der Idempotency-Key ist eine reine Funktion der Eingaben.
    const keyInput = {
      registry: getSliceRegistry(),
      refs: SLICE_REFS,
      entityIds: [ENTITY],
      timeframe: TF,
      availabilityPolicy: "ingested",
      mode: "INCREMENTAL",
      fromTs: closeOf(0),
      toTs: closeOf(29),
      datasetHashes: { [ENTITY]: store.valuesFor(ENTITY, RSI)[29].sourceManifest.datasetHash },
      codeVersion: "1.53.0-test",
    } as const;
    assert.equal(materializationRunKey(keyInput), materializationRunKey(keyInput));
    assert.notEqual(
      materializationRunKey({ ...keyInput, datasetHashes: { [ENTITY]: "ds1:" + "1".repeat(64) } }),
      materializationRunKey(keyInput),
      "andere Rohdaten-Revision ⇒ anderer Key"
    );
    assert.notEqual(materializationRunKey({ ...keyInput, mode: "BACKFILL" }), materializationRunKey(keyInput));
  });

  it("Trockenlauf rechnet, schreibt aber nichts (und registriert keine Definitionen)", async () => {
    const store = new FeatureMemoryStore();
    const dry = await materialize(store, { bars, asOf, policy: "ingested", dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.valuesWritten > 0, "der Trockenlauf meldet die geplanten Werte");
    assert.equal(store.values.size, 0);
    assert.equal(store.definitions.size, 0);
    assert.equal(store.runs.size, 0);
  });

  it("Fail-closed: nicht erreichbare Ablage bricht den Lauf ab (keine leere Erfolgsmeldung)", async () => {
    const store = new FeatureMemoryStore();
    store.failure = new Error("connection refused (simuliert)");
    await assert.rejects(
      () => materialize(store, { bars, asOf, policy: "ingested" }),
      /connection refused/
    );
    assert.equal(store.values.size, 0);
  });

  it("Scope-Grenzen und Feature-Allowlist werden geprüft", async () => {
    const store = new FeatureMemoryStore();
    await assert.rejects(
      () => materialize(store, { bars, asOf, policy: "ingested", entities: [] }),
      (e: unknown) => e instanceof FeatureStoreError && e.code === "FEATURE_SCOPE_EMPTY"
    );
    await assert.rejects(
      () => materialize(store, { bars, asOf, policy: "ingested", entities: ["SIM:BTC\nUSDT"] }),
      (e: unknown) => e instanceof FeatureStoreError && e.code === "FEATURE_SCOPE_INVALID"
    );
    await assert.rejects(
      () => materialize(store, { bars, asOf, policy: "ingested", refs: [{ featureId: "scanner.unbekannt", version: 1 }] }),
      (e: unknown) => e instanceof FeatureStoreError && e.code === "FEATURE_UNKNOWN"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Synthetischer Leakage-Test (Point-in-Time)
// ─────────────────────────────────────────────────────────────────────────────

describe("featureStore: Point-in-Time / Look-ahead", () => {
  /**
   * Szenario: 30 Stundenkerzen. Kerze 20 (Schluss 21:00Z) trifft erst um
   * 26:00Z ein (Feed-Ausfall, nachgelieferte Kerze); alle anderen sind eine
   * Minute nach Schluss da. Kerzen 21..29 haben dieselbe Kerze im
   * Lookback-Fenster und werden dadurch ebenfalls erst um 26:00Z bekannt.
   */
  const LATE_INDEX = 20;
  const lateBars = series(30, (b, i) => (i === LATE_INDEX ? bar(i, { fetchedAtMs: T0 + 26 * HOUR }) : b));
  const asOf = new Date(closeOf(29) + 5 * MINUTE);

  it("verspätete Kerze ist vor ihrem available_at unsichtbar (kein Leak, kein Look-ahead)", async () => {
    const store = new FeatureMemoryStore();
    await materialize(store, { bars: lateBars, asOf, policy: "ingested" });

    const late = store.valuesFor(ENTITY, RSI).find((r) => r.eventTime.getTime() === closeOf(LATE_INDEX));
    const before = store.valuesFor(ENTITY, RSI).find((r) => r.eventTime.getTime() === closeOf(LATE_INDEX - 1));
    assert.ok(late && before);
    assert.equal(late.availableAt.getTime(), T0 + 26 * HOUR, "Verfügbarkeit = tatsächliche Ingestion");
    assert.equal(before.availableAt.getTime(), closeOf(LATE_INDEX - 1) + MINUTE);
    assert.notEqual(late.value, before.value);

    // Entscheidung um 22:00Z, Ziel 21:00Z: der Wert der verspäteten Kerze ist
    // noch NICHT sichtbar — geliefert wird der letzte davor bekannte Wert.
    const early = await query(store, { asOf: T0 + 22 * HOUR, targetTime: closeOf(LATE_INDEX) });
    const earlyValue = row(early, RSI);
    assert.equal(earlyValue.status, "OK");
    assert.equal(earlyValue.eventTime, iso(closeOf(LATE_INDEX - 1)));
    assert.equal(earlyValue.value, before.value);
    assert.equal(earlyValue.stale, true, "der ältere Wert ist als stale markiert (nachgelagerte Entscheidung)");
    assert.notEqual(earlyValue.value, late.value, "Leak: der verspätete Wert darf hier nicht auftauchen");

    // Nach dem tatsächlichen Eintreffen (26:30Z) ist derselbe Wert sichtbar.
    const after = await query(store, { asOf: T0 + 26 * HOUR + 30 * MINUTE, targetTime: closeOf(LATE_INDEX) });
    const afterValue = row(after, RSI);
    assert.equal(afterValue.eventTime, iso(closeOf(LATE_INDEX)));
    assert.equal(afterValue.value, late.value);
    assert.equal(afterValue.availableAt, iso(T0 + 26 * HOUR));
    assert.equal(afterValue.stale, false);

    // Auch mit großzügigem `asOf` bleibt `event_time <= targetTime` hart:
    // Ziel 21:00Z ⇒ niemals der Wert einer späteren Kerze.
    const future = await query(store, { asOf: T0 + 40 * HOUR, targetTime: closeOf(LATE_INDEX) });
    assert.equal(row(future, RSI).eventTime, iso(closeOf(LATE_INDEX)));
    assert.equal(row(future, RSI).stale, true);
  });

  it("Politik bar_close macht den Unterschied explizit (Forschungsannahme vs. Fail-closed-Default)", async () => {
    const ingested = new FeatureMemoryStore();
    const barClose = new FeatureMemoryStore();
    await materialize(ingested, { bars: lateBars, asOf, policy: "ingested" });
    await materialize(barClose, { bars: lateBars, asOf, policy: "bar_close" });

    const at = { asOf: T0 + 22 * HOUR, targetTime: closeOf(LATE_INDEX) };
    assert.equal(row(await query(ingested, at), RSI).eventTime, iso(closeOf(LATE_INDEX - 1)));
    assert.equal(
      row(await query(barClose, at), RSI).eventTime,
      iso(closeOf(LATE_INDEX)),
      "bar_close unterstellt einen vollständigen, replay-sauberen Datensatz"
    );
    const stored = barClose.valuesFor(ENTITY, RSI).find((r) => r.eventTime.getTime() === closeOf(LATE_INDEX));
    assert.equal(stored?.availableAt.getTime(), closeOf(LATE_INDEX), "bar_close: availableAt = eventTime");
  });

  it("Missingness ist explizit: MISSING/NULL_VALUE mit value: null — nie ein Ersatzwert", async () => {
    const store = new FeatureMemoryStore();
    await materialize(store, { bars: series(30), asOf, policy: "ingested" });

    // Unbekannte Entity: es existiert kein Wert ⇒ MISSING (kein 0).
    const missing = await query(store, { asOf: asOf.getTime(), targetTime: asOf.getTime(), entities: "SIM:UNBEKANNT" });
    const missingValue = row(missing, RSI, "SIM:UNBEKANNT");
    assert.equal(missingValue.status, "MISSING");
    assert.equal(missingValue.value, null);
    assert.equal(missingValue.eventTime, null);
    assert.equal(missingValue.lagMs, null);
    assert.equal(missing.missing, 3);
    assert.equal(missing.matched, 0);

    // Zu wenig Historie ⇒ gespeicherte NULL-Zeile mit Grund = NULL_VALUE.
    const early = await query(store, { asOf: closeOf(3), targetTime: closeOf(3) });
    const earlyValue = row(early, RSI);
    assert.equal(earlyValue.status, "NULL_VALUE");
    assert.equal(earlyValue.value, null);
    assert.equal(earlyValue.nullReason, "INSUFFICIENT_LOOKBACK");
    assert.equal(early.nullValues, 3, "alle drei Features sind zu diesem Zeitpunkt NULL");
    assert.equal(early.matched, 3, "alle drei Paare haben eine (NULL-)Zeile — bedient, aber nicht nutzbar");
    assert.equal(early.missing, 0);
    assert.equal(early.matched + early.missing, early.requested);

    // Der Join wählt je Feature den jüngsten zulässigen Wert.
    const latest = await query(store, { asOf: asOf.getTime(), targetTime: closeOf(29) });
    assert.equal(row(latest, RSI).eventTime, iso(closeOf(29)));
    assert.equal(row(latest, BAND).dtype, "enum");
    assert.equal(latest.matched, 3);
    assert.equal(latest.missing, 0);
    assert.equal(latest.requested, 3);
  });

  it("Anfragevalidierung weist Look-ahead und Grenzverletzungen ab (fail-closed)", () => {
    const valid = validatePitQuery({
      asOf: iso(closeOf(5)),
      entities: ENTITY,
      features: `${RSI},${BAND}:1`,
      timeframe: TF,
    });
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.request.targetTime.getTime(), closeOf(5), "targetTime defaultet auf asOf");
      assert.deepEqual(valid.request.features, [{ featureId: RSI }, { featureId: BAND, version: 1 }]);
    }

    const cases: [string, Record<string, unknown>][] = [
      ["MISSING_AS_OF", { entities: ENTITY, features: RSI, timeframe: TF }],
      ["INVALID_AS_OF", { asOf: "gestern", entities: ENTITY, features: RSI, timeframe: TF }],
      ["INVALID_TARGET", { asOf: iso(closeOf(5)), targetTime: iso(closeOf(9)), entities: ENTITY, features: RSI, timeframe: TF }],
      ["INVALID_TIMEFRAME", { asOf: iso(closeOf(5)), entities: ENTITY, features: RSI, timeframe: "7h" }],
      ["MISSING_ENTITIES", { asOf: iso(closeOf(5)), entities: "", features: RSI, timeframe: TF }],
      ["MISSING_FEATURES", { asOf: iso(closeOf(5)), entities: ENTITY, features: [], timeframe: TF }],
      ["INVALID_ENTITIES", { asOf: iso(closeOf(5)), entities: "SIM:BTC USDT", features: RSI, timeframe: TF }],
      ["INVALID_FEATURES", { asOf: iso(closeOf(5)), entities: ENTITY, features: "Scanner.RSI", timeframe: TF }],
      ["INVALID_FEATURES", { asOf: iso(closeOf(5)), entities: ENTITY, features: `${RSI}:0`, timeframe: TF }],
      [
        "INVALID_ENTITIES",
        { asOf: iso(closeOf(5)), entities: `${ENTITY},${ENTITY}`, features: RSI, timeframe: TF },
      ],
      [
        "LIMIT_ENTITIES",
        {
          asOf: iso(closeOf(5)),
          entities: Array.from({ length: FEATURE_LIMITS.pitEntities + 1 }, (_, i) => `SIM:E${i}`),
          features: RSI,
          timeframe: TF,
        },
      ],
      [
        "LIMIT_ROWS",
        {
          asOf: iso(closeOf(5)),
          entities: Array.from({ length: FEATURE_LIMITS.pitEntities }, (_, i) => `SIM:E${i}`),
          features: Array.from({ length: FEATURE_LIMITS.pitFeatures }, (_, i) => `scanner.f${i}`),
          timeframe: TF,
        },
      ],
    ];
    for (const [code, raw] of cases) {
      const result = validatePitQuery(raw);
      assert.equal(result.ok, false, `Fall ${code} muss abgewiesen werden`);
      if (!result.ok) assert.ok(result.error.startsWith(code), `${code}: ${result.error}`);
    }

    // Unbekanntes Feature ist ein harter Fehler (kein „leeres Ergebnis“).
    const registry = getSliceRegistry();
    const unknown = {
      asOf: new Date(closeOf(5)),
      targetTime: new Date(closeOf(5)),
      entities: [ENTITY],
      features: [{ featureId: "scanner.unbekannt" }],
      timeframe: TF,
    } as const;
    expectStoreError(() => registry.require(unknown.features[0]), "FEATURE_UNKNOWN");
  });

  it("Quellgrenze wird abgelehnt statt still gekürzt (FEATURE_PIT_SOURCE_TRUNCATED)", async () => {
    const registry = getSliceRegistry();
    const source: PitSource = {
      readValues: async () => [{} as unknown as FeatureValueRow],
    };
    await assert.rejects(
      () =>
        runPitQuery(
          {
            asOf: new Date(closeOf(5)),
            targetTime: new Date(closeOf(5)),
            entities: [ENTITY],
            features: [{ featureId: RSI, version: 1 }],
            timeframe: TF,
          },
          source,
          registry,
          { sourceLimit: 1 }
        ),
      (e: unknown) => e instanceof FeatureStoreError && e.code === "FEATURE_PIT_SOURCE_TRUNCATED"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Datenrevision & Offline/Online-Parität
// ─────────────────────────────────────────────────────────────────────────────

describe("featureStore: Revision und Parität", () => {
  const bars = series(30);
  const asOf = new Date(closeOf(29) + 5 * MINUTE);

  it("Datenrevision wird protokolliert, nicht überschrieben; der Paritätsjob meldet den Grund", async () => {
    const store = new FeatureMemoryStore();
    await materialize(store, { bars, asOf, policy: "ingested" });
    const original = store.valuesFor(ENTITY, ATR).find((r) => r.eventTime.getTime() === closeOf(25));
    assert.ok(original);

    // Die Rohdaten werden fachlich korrigiert (dieselbe Eventzeit, anderer Kurs).
    const revised = series(30, (b, i) => (i === 25 ? { ...b, close: b.close * 1.4, high: b.high * 1.4 } : b));
    store.cursors.clear(); // vollständiger Re-Run (Backfill) über dieselben Bars
    const rerun = await materialize(store, { bars: revised, asOf, policy: "ingested" });

    assert.equal(rerun.revisions, 1, "genau ein abweichender Wert");
    assert.equal(rerun.definitionDrift.length, 0, "dieselbe Definition, nur andere Rohdaten");
    assert.equal(store.revisions.length, 1);
    const revision = store.revisions[0];
    assert.equal(revision.eventTime.getTime(), closeOf(25));
    assert.equal(revision.existingValueHash, original.valueHash);
    assert.notEqual(revision.incomingValueHash, original.valueHash);

    const after = store.valuesFor(ENTITY, ATR).find((r) => r.eventTime.getTime() === closeOf(25));
    assert.equal(after?.valueHash, original.valueHash, "der historische Wert bleibt gültig");
    assert.equal(after?.value, original.value);
    assert.equal(store.valuesFor(ENTITY, ATR).length, 30, "keine zweite Zeile für denselben Schlüssel");

    // PIT-Antwort liefert weiterhin den historisch gespeicherten Wert.
    const pit = await query(store, { asOf: asOf.getTime(), targetTime: closeOf(25), features: ATR });
    assert.equal(row(pit, ATR).value, original.value);

    // Paritätsjob: offline (korrigierte Rohdaten) vs. Store ⇒ DATASET_REVISION.
    const parity = await parityCheck(
      {
        refs: [{ featureId: ATR, version: 1 }],
        entityId: ENTITY,
        timeframe: TF,
        bars: revised,
        asOf,
        fromTs: new Date(closeOf(25) - HOUR),
        toTs: new Date(closeOf(25)),
      },
      { store, now: () => COMPUTED_AT }
    );
    assert.equal(parity.report.divergent, 1);
    assert.equal(parity.report.divergences[0].reason, "DATASET_REVISION");
    assert.equal(parity.report.divergences[0].eventTime, iso(closeOf(25)));

    // Und mit den ursprünglichen Rohdaten ist alles deckungsgleich.
    const clean = await parityCheck(
      {
        refs: [{ featureId: ATR, version: 1 }],
        entityId: ENTITY,
        timeframe: TF,
        bars,
        asOf,
        fromTs: new Date(closeOf(25) - HOUR),
        toTs: new Date(closeOf(25)),
      },
      { store, now: () => COMPUTED_AT }
    );
    assert.equal(clean.report.divergent, 0);
    assert.equal(clean.report.matched, clean.report.checked);
  });

  it("Store-Adapter und Compute-Adapter liefern denselben Wert (Offline/Online-Parität)", async () => {
    const store = new FeatureMemoryStore();
    /** Rohkerzen je Entity — unbekannte Entities haben KEINE Reihe (fail-closed). */
    const seriesByEntity: Readonly<Record<string, readonly FeatureBarInput[]>> = {
      [ENTITY]: bars,
      [ENTITY_B]: series(30, (b, i) => (i % 3 === 0 ? { ...b, close: b.close * 0.5 } : b)),
    };
    await materialize(store, {
      bars,
      asOf,
      policy: "ingested",
      entities: [ENTITY, ENTITY_B],
      barsFor: (entityId) => seriesByEntity[entityId] ?? [],
    });
    const request = (() => {
      const checked = validatePitQuery({
        asOf: iso(asOf.getTime()),
        targetTime: iso(closeOf(24)),
        entities: `${ENTITY},${ENTITY_B}`,
        features: `${RSI},${ATR},${BAND}`,
        timeframe: TF,
      });
      if (!checked.ok) assert.fail(`PIT-Anfrage ungültig: ${checked.error}`);
      return checked.request;
    })();

    const offline = createStoreBackedSource({ store });
    const online = createComputeBackedSource({
      timeframe: TF,
      // Die reale Verdrahtung liest die Rohkerzen der Entity; für eine unbekannte
      // Entity liefert der Historical Store nichts — daraus MUSS `MISSING`
      // folgen (kein Rat-Wert).
      barsFor: (entityId) => seriesByEntity[entityId] ?? [],
      now: () => COMPUTED_AT,
    });

    const stored = await offline.read(request);
    const computed = await online.read(request);
    assert.equal(offline.kind, "store");
    assert.equal(online.kind, "compute");
    assert.equal(computed.values.length, stored.values.length);
    for (let i = 0; i < stored.values.length; i++) {
      assert.equal(computed.values[i].featureId, stored.values[i].featureId);
      assert.equal(computed.values[i].entityId, stored.values[i].entityId);
      assert.equal(computed.values[i].status, stored.values[i].status);
      assert.equal(computed.values[i].value, stored.values[i].value);
      assert.equal(computed.values[i].eventTime, stored.values[i].eventTime);
      assert.equal(computed.values[i].definitionHash, stored.values[i].definitionHash);
    }
    // Beide Adapter sind fail-closed für unbekannte Entities.
    const unknownEntity = { ...request, entities: ["SIM:UNBEKANNT"] };
    assert.equal((await offline.read(unknownEntity)).values.every((v) => v.status === "MISSING"), true);
    assert.equal((await online.read(unknownEntity)).values.every((v) => v.status === "MISSING"), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Source-Quality, Betriebssicht, Metriken
// ─────────────────────────────────────────────────────────────────────────────

describe("featureStore: Quality und Betrieb", () => {
  const bars = series(30);
  const asOf = new Date(closeOf(29) + 5 * MINUTE);

  it("Source-Quality wird propagiert: schwerster Befund im Fenster gewinnt", async () => {
    const store = new FeatureMemoryStore();
    // Die Kerze mit Schluss 21:00Z ist als INVALID gemeldet, eine frühere als GAP.
    const qualityForBar = (_entityId: string, eventTimeMs: number): FeatureQualityStatus => {
      const close = eventTimeMs;
      if (close === closeOf(19)) return "GAP";
      if (close === closeOf(20)) return "INVALID";
      return "OK";
    };
    await materialize(store, { bars, asOf, policy: "ingested", qualityForBar });

    const rowAt = (index: number) => store.valuesFor(ENTITY, RSI).find((r) => r.eventTime.getTime() === closeOf(index));
    assert.equal(rowAt(2)?.qualityStatus, "OK");
    assert.equal(rowAt(18)?.qualityStatus, "OK", "Befund außerhalb des Fensters zählt nicht");
    assert.equal(rowAt(19)?.qualityStatus, "GAP");
    // Fenster von Bar 20 enthält Bar 19 (GAP) und Bar 20 (INVALID) ⇒ INVALID.
    assert.equal(rowAt(20)?.qualityStatus, "INVALID");
    // Fenster von Bar 21 enthält Bar 20 (INVALID) ⇒ INVALID (schwerer als GAP).
    assert.equal(rowAt(21)?.qualityStatus, "INVALID");

    // Ohne Qualitätsquelle: UNKNOWN („nicht geprüft“) — niemals OK.
    const unchecked = new FeatureMemoryStore();
    await materialize(unchecked, { bars, asOf, policy: "ingested" });
    assert.equal(unchecked.valuesFor(ENTITY, RSI).every((r) => r.qualityStatus === "UNKNOWN"), true);
    assert.equal(windowQualityStatus(["OK", "UNKNOWN"]), "UNKNOWN");
    assert.equal(windowQualityStatus([]), "OK");
  });

  it("Quality-Reports werden je Reihe gefiltert und auf Fenster abgebildet", () => {
    const report = {
      series: [
        {
          instrumentId: ENTITY,
          timeframe: TF,
          findings: [
            { cls: "GAP" as const, ts: closeOf(5), detail: "Lücke" },
            { cls: "CROSSCHECK" as const, detail: "Abweichung zwischen Venues" },
            { cls: "OUTLIER" as const, ts: closeOf(19), detail: "Ausreißer" },
          ],
        },
      ],
    } as never;

    const findings = findingsForSeries(report, ENTITY, TF);
    assert.equal(findings.length, 3);
    assert.equal(findingsForSeries(report, "SIM:ANDERE", TF).length, 0);
    assert.equal(findingsForSeries(null, ENTITY, TF).length, 0, "kein Report ⇒ keine Befunde (Aufrufer setzt UNKNOWN)");

    // Fenster ohne Befund ⇒ OK; Fenster mit OUTLIER ⇒ OUTLIER; Serienbefund
    // (ohne ts) zählt in jedem Fenster.
    assert.equal(
      qualityStatusForWindow(findings, closeOf(10), closeOf(12), (s) => FEATURE_QUALITY_SEVERITY[s]),
      "CROSSCHECK"
    );
    assert.equal(
      qualityStatusForWindow(findings, closeOf(4), closeOf(6), (s) => FEATURE_QUALITY_SEVERITY[s]),
      "GAP"
    );
    assert.equal(
      qualityStatusForWindow(findings, closeOf(19), closeOf(20), (s) => FEATURE_QUALITY_SEVERITY[s]),
      "OUTLIER"
    );
    assert.equal(qualityStatusForWindow([], closeOf(0), closeOf(1), (s) => FEATURE_QUALITY_SEVERITY[s]), "OK");
  });

  it("Betriebssicht zeigt Coverage, Lag, Revisionen und unregistrierte Store-Reihen", async () => {
    const store = new FeatureMemoryStore();
    await materialize(store, { bars, asOf, policy: "ingested" });

    // Eine Reihe, die die Registry des Slices nicht kennt (z. B. ältere
    // Version aus einem Rollback) — sie muss sichtbar bleiben.
    const probe = FeatureRegistry.create(
      [
        {
          featureId: "featuretest.probe",
          version: 1,
          label: "Testsonde",
          description: "Nur für den Betriebssicht-Test.",
          dtype: "number",
          enumValues: null,
          unit: "index_0_100",
          valueDecimals: 4,
          entityType: "instrument",
          timeframe: TF,
          lookbackBars: DEFAULT_SCANNER_CONFIG.factors.rsi.period + 1,
          dependencies: [],
          computeKey: "scanner.rsi@1",
          config: { period: DEFAULT_SCANNER_CONFIG.factors.rsi.period },
          owner: "featuretest",
        },
      ],
      FEATURE_EXECUTORS
    );
    await materialize(store, {
      bars,
      asOf,
      policy: "ingested",
      refs: [{ featureId: "featuretest.probe", version: 1 }],
      registry: probe,
    });

    const now = () => new Date(closeOf(29) + 2 * HOUR);
    const status = await featureStoreStatus({ store, now, runLimit: 5, revisionLimit: 5 });
    assert.equal(status.definitions.length, 3);
    assert.equal(status.definitions.find((d) => d.featureId === RSI)?.owner, "scanner");
    assert.equal(status.series.filter((s) => s.registered).length, 3);
    const probeSeries = status.series.find((s) => s.featureId === "featuretest.probe");
    assert.ok(probeSeries);
    assert.equal(probeSeries.registered, false);
    assert.equal(probeSeries.label, "(nicht registriert)");

    const rsiSeries = status.series.find((s) => s.featureId === RSI);
    assert.ok(rsiSeries);
    assert.equal(rsiSeries.rows, 30);
    assert.equal(rsiSeries.entities, 1);
    assert.equal(rsiSeries.nullRows, DEFAULT_SCANNER_CONFIG.factors.rsi.period);
    assert.equal(rsiSeries.unknownQualityRows, 30);
    assert.equal(rsiSeries.minEventTime, iso(closeOf(0)));
    assert.equal(rsiSeries.maxEventTime, iso(closeOf(29)));
    assert.equal(rsiSeries.maxWatermark, iso(closeOf(29)));
    assert.equal(rsiSeries.cursoredEntities, 1);
    assert.equal(rsiSeries.lagMs, 2 * HOUR - HOUR, "Eventzeit + 1h Schlusszeit vs. jetzt (+2h)");
    assert.equal(status.runs.length, 4, "ein Manifest je Entity/Feature-Kombination des Laufs");
    assert.equal(status.revisions.length, 0);
    assert.equal(status.codeVersion, "1.53.0");
    assert.equal(status.timeframe, TF);

    // Retention: ein wertfreier, fehlgeschlagener Lauf verschwindet, der
    // erfolgreiche Lauf mit Werten bleibt.
    await store.recordFailedRun({
      id: "run-failed",
      idempotencyKey: "fm1:" + "9".repeat(64),
      mode: "BACKFILL",
      status: "FAILED",
      timeframe: TF,
      availabilityPolicy: "ingested",
      featureRefs: [{ featureId: RSI, version: 1 }],
      entityIds: [ENTITY],
      fromTs: null,
      toTs: null,
      counts: {
        barsConsidered: 0,
        skippedBeforeCursor: 0,
        gapBars: 0,
        valuesWritten: 0,
        duplicates: 0,
        revisions: 0,
        nullValues: 0,
      },
      definitionHashes: {},
      sourceManifests: {},
      cursorBefore: [] as FeatureCursor[],
      cursorAfter: [] as FeatureCursor[],
      codeVersion: "1.53.0-test",
      errorCode: "FEATURE_PLAN_INVALID",
      startedAt: COMPUTED_AT,
      finishedAt: COMPUTED_AT,
    });
    assert.equal((await store.recentRuns(50)).length, 5);
    assert.equal(await store.pruneRuns(0), 1);
    assert.equal((await store.recentRuns(50)).length, 4);
  });

  it("Metriken zählen Materialisierung und Parität — ohne Entity-IDs als Label", async () => {
    telemetry.features.reset();
    const store = new FeatureMemoryStore();
    await materialize(store, { bars, asOf, policy: "ingested" });
    await parityCheck(
      { refs: [SLICE_REFS[0]], entityId: ENTITY, timeframe: TF, bars, asOf, fromTs: new Date(closeOf(0)), toTs: asOf },
      { store, now: () => COMPUTED_AT }
    );

    const exposition = [
      telemetry.features.materializationValues.exposition(),
      telemetry.features.materializationRuns.exposition(),
      telemetry.features.parityChecks.exposition(),
    ].join("\n");
    assert.match(exposition, /feature_materialization_values_total\{/);
    assert.match(exposition, /feature_materialization_runs_total\{.*result="ok".*\} 1/);
    assert.match(exposition, /feature_parity_checks_total\{result="match"\} 1/);
    assert.ok(!exposition.includes(ENTITY), "Entity-IDs dürfen keine Labels sein (Kardinalitätsregel)");
  });

  it("Coverage-Hilfen rechnen dasselbe Raster wie die Materialisierung", async () => {
    const store = new FeatureMemoryStore();
    await materialize(store, { bars, asOf, policy: "ingested" });
    const coverage = await store.coverage({ timeframe: TF });
    assert.equal(coverage.length, 3);
    for (const series_ of coverage) {
      assert.equal(series_.rows, 30);
      assert.equal(series_.entities, 1);
      assert.equal(series_.maxEventTime, iso(closeOf(29)));
    }
  });
});
