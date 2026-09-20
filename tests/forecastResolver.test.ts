/**
 * Forecast-Resolver — End-to-End-Tests ohne Datenbank (RMA-P3-01, v1.55.0).
 *
 * Deckt die Pflichtfälle ab:
 *   * Idempotenz: zwei Läufe ⇒ genau eine Resolution,
 *   * kein Zugriff auf Daten nach dem Outcome-Cutoff (später `fetchedAt`
 *     ⇒ für die Erstauflösung unsichtbar ⇒ VOID statt Look-ahead),
 *   * Missing/Halt ⇒ VOID mit geschlossenem Grund, nie automatisch falsch,
 *   * verzögerte Kerzen innerhalb der Deadline ⇒ RESOLVED (delayed, nicht VOID),
 *   * Datenkorrektur ⇒ versionierte Re-Resolution statt stiller Mutation,
 *   * Restart nach Teilfehler ⇒ kein Duplikat, vollständiger Abschluss,
 *   * Lauf-Manifest und Wasserstand (monoton).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateForecast,
  expectedBarCount,
  reResolveForecast,
  runForecastResolution,
  voidForecastByOperator,
  type ForecastResolverDeps,
} from "../src/forecasts/resolver";
import { FORECAST_SETTLE_GRACE_MS } from "../src/forecasts/types";
import {
  barOf,
  FC_HOUR,
  FC_T0,
  InMemoryForecastLedger,
  InMemoryOutcomeStore,
  testContract,
} from "./fixtures/forecastTestUtil";

const HOUR = FC_HOUR;
const GRACE = FORECAST_SETTLE_GRACE_MS;

interface World {
  ledger: InMemoryForecastLedger;
  store: InMemoryOutcomeStore;
  deps: ForecastResolverDeps;
  now: Date;
  setNow(ms: number): void;
  liveCalls: string[];
}

function makeWorld(startMs: number): World {
  const ledger = new InMemoryForecastLedger();
  const store = new InMemoryOutcomeStore();
  let nowMs = startMs;
  const liveCalls: string[] = [];
  const world: World = {
    ledger,
    store,
    now: new Date(startMs),
    liveCalls,
    setNow(ms: number) {
      nowMs = ms;
      world.now = new Date(ms);
    },
    deps: {
      ledger,
      outcomeRead: store,
      outcomeWrite: store,
      now: () => new Date(nowMs),
      codeVersion: "test-1.0.0",
      fetchLiveBars: async (symbol) => {
        liveCalls.push(symbol);
        return [];
      },
    },
  };
  return world;
}

/** 4h-Forecast: Referenz 00:00 (100), Auflösung 04:00, Deadline 06:00. */
function makeWorldWithForecast(outcomeClose: number | null, opts: { fetchedAtMs?: number; volume?: number } = {}) {
  const world = makeWorld(FC_T0 + 6 * HOUR + 30 * 60_000); // nach der Deadline
  const contract = testContract(); // Referenz FC_T0, resolves FC_T0+4h
  const referenceBar = barOf(FC_T0, 100, 500);
  void world.store.appendBars(contract.entityId, "1h", [referenceBar], new Date(FC_T0 - 30 * 60_000));
  if (outcomeClose !== null) {
    void world.store.appendBars(
      contract.entityId,
      "1h",
      [barOf(FC_T0 + 4 * HOUR, outcomeClose, opts.volume ?? 900)],
      new Date(opts.fetchedAtMs ?? FC_T0 + 5 * HOUR) // vor der Deadline verfügbar
    );
  }
  return { world, contract };
}

describe("forecastResolver: Bewertung (rein)", () => {
  it("strikt größer ⇒ UP(1); Gleichstand ⇒ DOWN(0) — Policy fp1", () => {
    const contract = testContract();
    const bars = [
      { closeTimeMs: FC_T0, openTimeMs: FC_T0 - HOUR, close: 100, volume: 500, fetchedAtMs: FC_T0 },
      { closeTimeMs: FC_T0 + 4 * HOUR, openTimeMs: FC_T0 + 3 * HOUR, close: 100.01, volume: 900, fetchedAtMs: FC_T0 + 5 * HOUR },
    ];
    const up = evaluateForecast(contract, bars, FC_T0 + 4 * HOUR + GRACE);
    assert.equal(up.kind, "RESOLVED");
    if (up.kind === "RESOLVED") {
      assert.equal(up.outcomeLabel, "UP");
      assert.equal(up.outcomeBinary, 1);
      assert.equal(up.outcomeIndex, 1);
    }
    const tie = evaluateForecast(contract, [{ ...bars[0] }, { ...bars[1], close: 100 }], FC_T0 + 4 * HOUR + GRACE);
    assert.equal(tie.kind, "RESOLVED");
    if (tie.kind === "RESOLVED") {
      assert.equal(tie.outcomeLabel, "DOWN");
      assert.equal(tie.outcomeBinary, 0);
    }
  });

  it("erwartete Kerzenanzahl des Fensters", () => {
    assert.equal(expectedBarCount(FC_T0, FC_T0 + 4 * HOUR), 4);
    assert.equal(expectedBarCount(FC_T0, FC_T0), 0);
  });
});

describe("forecastResolver: Auflösungslauf", () => {
  it("auflösen mit verfügbaren Kerzen ⇒ RESOLVED mit Manifest und Dataset-Hash", async () => {
    const { world, contract } = makeWorldWithForecast(105);
    const recorded = await world.ledger.recordForecast(contract, { source: "test" });
    assert.ok(recorded.created);

    const result = await runForecastResolution(world.deps);
    assert.equal(result.counts.dueConsidered, 1);
    assert.equal(result.counts.resolved, 1);
    assert.equal(result.counts.failed, 0);

    const view = await world.ledger.loadForecast(recorded.forecastId);
    assert.ok(view);
    assert.equal(view.status, "RESOLVED");
    assert.equal(view.latestResolution?.outcome?.outcomeLabel, "UP");
    assert.equal(view.latestResolution?.outcome?.outcomeBinary, 1);
    assert.equal(view.latestResolution?.outcome?.referenceClose, 100);
    assert.equal(view.latestResolution?.outcome?.outcomeClose, 105);
    assert.equal(view.latestResolution?.resolutionKind, "AUTOMATIC");
    assert.equal(view.latestResolution?.resolutionVersion, 1);
    const manifest = view.latestResolution?.outcomeManifest as Record<string, unknown>;
    assert.match(String(manifest.datasetHash), /^ds1:[0-9a-f]{64}$/);
    assert.equal(manifest.policyVersion, "fp1");
  });

  it("Idempotenz: zweiter Lauf erzeugt KEINE zweite Resolution", async () => {
    const { world, contract } = makeWorldWithForecast(95);
    await world.ledger.recordForecast(contract, { source: "test" });

    const first = await runForecastResolution(world.deps);
    assert.equal(first.counts.resolved, 1);
    const second = await runForecastResolution(world.deps);
    assert.equal(second.counts.dueConsidered, 0, "bereits aufgelöste Forecasts sind nicht mehr fällig");
    assert.equal(second.counts.resolved, 0);

    const id = await forecastIdOf(world, contract);
    const view = await world.ledger.loadForecast(id);
    assert.equal(view?.status, "RESOLVED");
    assert.equal(world.ledger.resolutionsOf(id).length, 1, "genau eine Resolution nach zwei Läufen");
  });

  it("kein Look-ahead: Kerze NACH der Deadline ist für die Erstauflösung unsichtbar ⇒ VOID(MISSING_DATA)", async () => {
    // Outcome-Kerze existiert, wurde aber erst NACH der Deadline geschrieben.
    const { world, contract } = makeWorldWithForecast(110, {
      fetchedAtMs: FC_T0 + 4 * HOUR + GRACE + 60_000, // nach der Deadline
    });
    await world.ledger.recordForecast(contract, { source: "test" });
    const result = await runForecastResolution(world.deps);
    assert.equal(result.counts.voided, 1);
    assert.equal(result.counts.resolved, 0);
    const id = await forecastIdOf(world, contract);
    const view = await world.ledger.loadForecast(id);
    assert.equal(view?.status, "VOID");
    assert.equal(view?.latestResolution?.voidReason, "MISSING_DATA");
  });

  it("fehlende Outcome-Kerze ⇒ VOID(MISSING_DATA), nie automatisch falsch", async () => {
    const { world, contract } = makeWorldWithForecast(null);
    await world.ledger.recordForecast(contract, { source: "test" });
    const result = await runForecastResolution(world.deps);
    assert.equal(result.counts.voided, 1);
    const id = await forecastIdOf(world, contract);
    const view = await world.ledger.loadForecast(id);
    assert.equal(view?.latestResolution?.voidReason, "MISSING_DATA");
  });

  it("volumenloses Auflösungsfenster ⇒ VOID(TRADING_HALT)", async () => {
    const { world, contract } = makeWorldWithForecast(102, { volume: 0 });
    await world.ledger.recordForecast(contract, { source: "test" });
    const result = await runForecastResolution(world.deps);
    assert.equal(result.counts.voided, 1);
    const id = await forecastIdOf(world, contract);
    const view = await world.ledger.loadForecast(id);
    assert.equal(view?.latestResolution?.voidReason, "TRADING_HALT");
  });

  it("unreife Forecasts (vor der Deadline) werden nicht aufgelöst", async () => {
    // now VOR der Deadline: der Forecast ist noch nicht fällig.
    const world = makeWorld(FC_T0 + 3 * HOUR);
    const contract = testContract();
    await world.store.appendBars(contract.entityId, "1h", [barOf(FC_T0, 100)], new Date(FC_T0));
    await world.ledger.recordForecast(contract, { source: "test" });
    const result = await runForecastResolution(world.deps);
    assert.equal(result.counts.dueConsidered, 0);
    const id = await forecastIdOf(world, contract);
    const view = await world.ledger.loadForecast(id);
    assert.equal(view?.status, "PENDING");
  });

  it("Feed-Phase schreibt Live-Kerzen in den Store, bevor die Deadline entscheidet", async () => {
    const world = makeWorld(FC_T0 + 4 * HOUR + 30 * 60_000); // resolves erreicht, Deadline offen
    const contract = testContract();
    await world.store.appendBars(contract.entityId, "1h", [barOf(FC_T0, 100)], new Date(FC_T0));
    await world.ledger.recordForecast(contract, { source: "test" });
    // Live-Quelle liefert die Outcome-Kerze.
    world.deps.fetchLiveBars = async () => [barOf(FC_T0 + 4 * HOUR, 108)];
    const feedRun = await runForecastResolution(world.deps);
    assert.equal(feedRun.counts.dueConsidered, 0, "vor der Deadline wird nicht aufgelöst");
    assert.ok(feedRun.fed >= 1, "die Feed-Phase hat die Kerze in den Store geschrieben");

    // Nach der Deadline: Auflösung aus dem Store — ohne weiteren Live-Zugriff.
    world.setNow(FC_T0 + 4 * HOUR + GRACE + 10 * 60_000);
    let liveUsed = false;
    world.deps.fetchLiveBars = async () => {
      liveUsed = true;
      return [];
    };
    const result = await runForecastResolution(world.deps);
    assert.equal(result.counts.resolved, 1);
    assert.equal(liveUsed, false, "die Resolve-Phase liest ausschließlich den Store");
    const id = await forecastIdOf(world, contract);
    const view = await world.ledger.loadForecast(id);
    assert.equal(view?.latestResolution?.outcome?.outcomeClose, 108);
  });

  it("Restart nach Teilfehler: kein Duplikat und vollständiger Abschluss", async () => {
    const { world, contract } = makeWorldWithForecast(99);
    await world.ledger.recordForecast(contract, { source: "test" });

    // Erster Lauf: Write scheitert injiziert → der Forecast bleibt offen.
    world.ledger.failNextAppend = new Error("db-down");
    const failed = await runForecastResolution(world.deps);
    assert.equal(failed.counts.failed, 1);
    assert.equal(failed.counts.resolved, 0);

    // Restart: derselbe Zustand, jetzt erfolgreich — genau eine Resolution.
    const retry = await runForecastResolution(world.deps);
    assert.equal(retry.counts.resolved, 1);
    assert.equal(retry.counts.duplicates, 0);
    const id = await forecastIdOf(world, contract);
    assert.equal(world.ledger.resolutionsOf(id).length, 1);
    const view = await world.ledger.loadForecast(id);
    assert.equal(view?.status, "RESOLVED");
  });

  it("Load-Fehler je Forecast bricht den Lauf nicht ab (fail-closed, laut gezählt)", async () => {
    const { world, contract } = makeWorldWithForecast(101);
    await world.ledger.recordForecast(contract, { source: "test" });
    world.store.failNextLoad = new Error("io-error");
    const result = await runForecastResolution(world.deps);
    assert.equal(result.counts.failed, 1);
    assert.equal(result.counts.resolved, 0);
    const id = await forecastIdOf(world, contract);
    const view = await world.ledger.loadForecast(id);
    assert.equal(view?.status, "PENDING", "Fehler darf kein Outcome erzwingen");
  });

  it("Wasserstand bewegt sich nur vorwärts und wird im Lauf-Manifest dokumentiert", async () => {
    const { world, contract } = makeWorldWithForecast(103);
    await world.ledger.recordForecast(contract, { source: "test" });
    const before = await world.ledger.readCursor();
    assert.equal(before, null);
    const result = await runForecastResolution(world.deps);
    assert.ok(result.watermarkDeadline);
    assert.equal(result.watermarkDeadline.getTime(), contract.availabilityDeadline.getTime());
    const cursor = await world.ledger.readCursor();
    assert.ok(cursor);
    assert.equal(cursor.watermarkDeadline.getTime(), contract.availabilityDeadline.getTime());
    assert.ok(world.ledger.runCount() >= 1, "Lauf-Manifest wurde geschrieben");
  });
});

describe("forecastResolver: versionierte Re-Resolution und Operator-VOID", () => {
  it("Datenkorrektur ⇒ NEUE Resolution-Version, Historie bleibt unangetastet", async () => {
    const { world, contract } = makeWorldWithForecast(105);
    const recorded = await world.ledger.recordForecast(contract, { source: "test" });
    await runForecastResolution(world.deps);
    const viewBefore = await world.ledger.loadForecast(recorded.forecastId);
    assert.equal(viewBefore?.latestResolution?.outcome?.outcomeClose, 105);
    assert.equal(viewBefore?.latestResolution?.outcome?.outcomeLabel, "UP");

    // Korrektur: derselbe Bar wird mit abweichendem Kurs ersetzt (jüngerer Abruf).
    await world.store.appendBars(
      contract.entityId,
      "1h",
      [barOf(FC_T0 + 4 * HOUR, 92)], // jetzt DOWN
      new Date(FC_T0 + 12 * HOUR)
    );

    // Die Re-Resolution geschieht NACH der Korrektur (Operator-Zeit >= Abrufzeit).
    world.setNow(FC_T0 + 13 * HOUR);
    const result = await reResolveForecast(world.deps, {
      forecastId: recorded.forecastId,
      actorId: "admin",
      reason: "DATA_CORRECTION",
      note: "Kerze 04:00 korrigiert",
    });
    assert.equal(result.created, true);
    assert.equal(result.resolutionVersion, 2);
    assert.equal(result.status, "RESOLVED");

    const history = world.ledger.resolutionsOf(recorded.forecastId);
    assert.equal(history.length, 2, "beide Versionen bleiben erhalten (append-only)");
    assert.equal(history[0].resolutionVersion, 1);
    assert.equal(history[0].outcome?.outcomeClose, 105);
    assert.equal(history[1].resolutionVersion, 2);
    assert.equal(history[1].outcome?.outcomeClose, 92);
    assert.equal(history[1].outcome?.outcomeLabel, "DOWN");
    assert.equal(history[1].resolutionKind, "OPERATOR");

    // Wirksstatus folgt der jüngsten Version.
    const viewAfter = await world.ledger.loadForecast(recorded.forecastId);
    assert.equal(viewAfter?.latestResolution?.outcome?.outcomeLabel, "DOWN");
  });

  it("identische Re-Resolution ⇒ no-op (Idempotenz über Outcome-Hash)", async () => {
    const { world, contract } = makeWorldWithForecast(105);
    const recorded = await world.ledger.recordForecast(contract, { source: "test" });
    await runForecastResolution(world.deps);
    const result = await reResolveForecast(world.deps, {
      forecastId: recorded.forecastId,
      actorId: "admin",
      reason: "DATA_CORRECTION",
    });
    assert.equal(result.created, false);
    assert.equal(result.resolutionVersion, 1);
    assert.equal(world.ledger.resolutionsOf(recorded.forecastId).length, 1);
  });

  it("Operator-VOID (Corporate Action) hängt begründete VOID-Resolution an", async () => {
    const { world, contract } = makeWorldWithForecast(105);
    const recorded = await world.ledger.recordForecast(contract, { source: "test" });
    const result = await voidForecastByOperator(world.deps, {
      forecastId: recorded.forecastId,
      actorId: "admin",
      reason: "CORPORATE_ACTION",
      voidReason: "CORPORATE_ACTION",
      note: "Reverse Split im Auflösungsfenster",
    });
    assert.equal(result.created, true);
    const view = await world.ledger.loadForecast(recorded.forecastId);
    assert.equal(view?.status, "VOID");
    assert.equal(view?.latestResolution?.voidReason, "CORPORATE_ACTION");
    // Wiederholung mit identischem Inhalt ⇒ no-op.
    const repeat = await voidForecastByOperator(world.deps, {
      forecastId: recorded.forecastId,
      actorId: "admin",
      reason: "CORPORATE_ACTION",
      voidReason: "CORPORATE_ACTION",
      note: "Reverse Split im Auflösungsfenster",
    });
    assert.equal(repeat.created, false);
    assert.equal(world.ledger.resolutionsOf(recorded.forecastId).length, 1);
  });

  it("ungültige Operator-Eingaben werden fail-closed abgewiesen", async () => {
    const { world, contract } = makeWorldWithForecast(105);
    const recorded = await world.ledger.recordForecast(contract, { source: "test" });
    await assert.rejects(
      reResolveForecast(world.deps, { forecastId: recorded.forecastId, actorId: "admin", reason: "WEIL_ICH_ES_SAGE" }),
      /Operator-Grund/
    );
    await assert.rejects(
      voidForecastByOperator(world.deps, {
        forecastId: recorded.forecastId,
        actorId: "admin",
        reason: "CORPORATE_ACTION",
        voidReason: "KEIN_GRUND",
      }),
      /VOID-Grund/
    );
    await assert.rejects(
      reResolveForecast(world.deps, { forecastId: "gibt-es-nicht", actorId: "admin", reason: "DATA_CORRECTION" }),
      /existiert nicht/
    );
  });
});

/** Id eines erfassten Testvertrags über den (idempotenten) Schlüssel finden. */
async function forecastIdOf(world: World, contract: ReturnType<typeof testContract>): Promise<string> {
  const recorded = await world.ledger.recordForecast(contract, { source: "test" });
  return recorded.forecastId;
}
