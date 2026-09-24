/**
 * Konsumenten der Perpetual-Daten (RMA-P2-02): as-of-Abfrage, Derivatekontext,
 * Funding-Replay, Derivat-Artefakt und Analystenzeilen.
 *
 * Der gemeinsame Nenner aller Tests: **fehlende Daten dürfen nie wie eine
 * Zahl aussehen.** Die as-of-Grenze ist dabei die zweite Hälfte — ein Satz,
 * der zum Auswertungszeitpunkt noch nicht bekannt sein durfte, ist für einen
 * Backtest nicht „später verfügbar“, sondern „existiert nicht“.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadPerpConfig } from "../src/perpdata/config";
import { InMemoryPerpStore } from "../src/perpdata/memoryStore";
import {
  PERP_QUERY_REASONS,
  filterRowsAsOf,
  latestPerpRows,
  queryPerpSeries,
  validateAsOfRequest,
} from "../src/perpdata/query";
import { PerpQueryError } from "../src/perpdata/errors";
import {
  buildPerpDerivativeSnapshots,
  createPerpFundingRateProvider,
  perpAnalystSnapshotLines,
  perpAnalystSnapshotLinesFromCache,
  perpDerivativeProvider,
  perpSnapshotToDerivativeContext,
} from "../src/perpdata/consumers";
import {
  buildPerpDerivativeCache,
  loadPerpDerivativeCache,
  perpDerivativeContextsFromCache,
  savePerpDerivativeCache,
} from "../src/perpdata/derivativeCache";
import { computeReplayAccruals, fundingRateTo8h, replayPositionFunding } from "../src/perpdata/replay";
import {
  normalizeFundingRow,
  normalizeLiquidationRow,
  normalizeOpenInterestRow,
  type PerpNormalizeContext,
} from "../src/perpdata/normalize";
import { PERP_LIMITS, type PerpFundingRow, type PerpQualityStatus } from "../src/perpdata/types";
import type { PerpCommit, PerpRunRecord } from "../src/perpdata/ports";
import type { MarketInstrument } from "../src/universe/types";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 3_600_000;
const INTERVAL = 8 * HOUR;
const T0 = NOW_MS - 4 * INTERVAL;

const ENV = {
  PERP_DATA_ENABLED: "true",
  PERP_DATA_SYNC_ENABLED: "true",
  PERP_DATA_VENUES: "SIM",
  PERP_DATA_SAFETY_LAG_MS: "0",
} as const;

function config(overrides: Record<string, string> = {}) {
  return loadPerpConfig({ ...ENV, ...overrides });
}

function instrument(symbol = "BTCUSDT"): MarketInstrument {
  return {
    id: `SIM:${symbol}`,
    venue: "SIM",
    symbol,
    base: symbol.replace(/USDT$/, ""),
    quote: "USDT",
    assetClass: "crypto",
    marketType: "perpetual",
    status: "active",
    minQuantity: 0.001,
    priceStep: 0.1,
    quantityStep: 0.001,
    makerFee: 0.0002,
    takerFee: 0.0006,
    leverageAvailable: true,
    shortAvailable: true,
    paperAvailable: true,
    liveTradable: false,
    liveAvailable: false,
    volume24h: null,
    spread: null,
    bookDepthUsd: null,
    volatility: null,
    lastSeen: NOW.toISOString(),
  };
}

const BTC = instrument("BTCUSDT");

function ctx(overrides: Partial<PerpNormalizeContext> = {}): PerpNormalizeContext {
  return {
    venue: "SIM",
    instrumentId: BTC.id,
    symbol: BTC.symbol,
    sourceId: "sim:v1",
    fetchedAt: NOW,
    availabilityPolicy: "ingested",
    maxAbsFundingRate: 0.0075,
    ...overrides,
  };
}

/** Füllt eine Speicher-Ablage mit einer Funding-/OI-/Liquidations-Serie. */
async function seedStore(options: {
  fundingCount?: number;
  /** `availableAt` des letzten Satzes nach hinten (as-of-Sichtbarkeit). */
  lateRows?: number;
  intervalMs?: number;
  /** Untere Grenze der Serie (Default: 4 Intervalle vor `NOW`). */
  baseMs?: number;
  oiCount?: number;
  /**
   * OI-Serie als Alter (h) + Quote-Wert — für Δ24h braucht der Test Punkte in
   * definiertem Abstand; `basis` ist hier `quote_units` (was der
   * Scanner-Kontext vertraglich verlangt).
   */
  oiSeries?: readonly { ageHours: number; quote: number }[];
  /** OI in Basis-Einheit gemeldet (die Quote-Ableitung bleibt unmarkiert). */
  oiBaseUnitsOnly?: boolean;
  /** Qualitätsstatus je OI-Satz (indexgleich) — für Belegbarkeits-Tests. */
  oiFlags?: readonly (PerpQualityStatus | undefined)[];
  liquidationCount?: number;
} = {}) {
  const store = new InMemoryPerpStore();
  const intervalMs = options.intervalMs ?? INTERVAL;
  const fundingCount = options.fundingCount ?? 4;
  const funding: PerpFundingRow[] = [];
  for (let index = 0; index < fundingCount; index += 1) {
    const eventMs = (options.baseMs ?? T0) + index * intervalMs;
    const late = options.lateRows !== undefined && index >= fundingCount - options.lateRows;
    funding.push(
      normalizeFundingRow({ eventTime: eventMs, fundingRate: 0.0001 * (index + 1), intervalHours: intervalMs / HOUR }, index, ctx({ fetchedAt: late ? new Date(NOW_MS + 10 * HOUR) : NOW })).row!
    );
  }
  const flag = (row: { qualityStatus: PerpQualityStatus }, index: number) => {
    const status = options.oiFlags?.[index];
    return status === undefined ? row : { ...row, qualityStatus: status };
  };
  const oi =
    options.oiSeries !== undefined
      ? options.oiSeries.map((entry, index) =>
          flag(
            normalizeOpenInterestRow(
              {
                eventTime: NOW_MS - entry.ageHours * HOUR,
                quoteValue: entry.quote,
                basis: "quote_units",
                quoteCurrency: "USDT",
              },
              index,
              ctx()
            ).row!,
            index
          )
        )
      : Array.from({ length: options.oiCount ?? 3 }, (_, index) =>
          options.oiBaseUnitsOnly === true
            ? normalizeOpenInterestRow(
                {
                  // Nur die Basis-Menge ist autoritativ gemeldet: der
                  // Scanner-Kontext verlangt Quote ⇒ kein Wert, mit Grund
                  // (eigener Test unten) — nie eine umgedeutete Zahl.
                  eventTime: NOW_MS - (index + 1) * HOUR,
                  baseQuantity: 100 + index,
                  basis: "base_units",
                  quoteCurrency: "USDT",
                },
                index,
                ctx()
              ).row!
            : normalizeOpenInterestRow(
                {
                  eventTime: NOW_MS - (index + 1) * HOUR,
                  baseQuantity: 100 + index,
                  quoteValue: 6_600_000 + index * 1000,
                  basis: "base_units",
                  quoteCurrency: "USDT",
                },
                index,
                ctx()
              ).row!
        );
  const liquidations = Array.from({ length: options.liquidationCount ?? 2 }, (_, index) =>
    normalizeLiquidationRow(
      { eventTime: NOW_MS - (index + 1) * 30 * 60_000, side: "SELL", quantityBase: 0.5 + index, price: 66_000, sourceEventId: `liq-${index}` },
      index,
      ctx({ quoteCurrency: "USDT" })
    ).row!
  );
  const run: PerpRunRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "prk1:test-seed",
    venue: "SIM",
    mode: "BACKFILL",
    status: "SUCCEEDED",
    availabilityPolicy: "ingested",
    fromTs: new Date(T0),
    toTs: new Date(NOW_MS),
    kinds: ["funding", "openInterest", "liquidations"],
    instrumentIds: [BTC.id],
    counts: {},
    capabilities: {
      funding: { supported: true, sourceId: "sim:funding" },
      openInterest: { supported: true, sourceId: "sim:oi" },
      liquidations: { supported: true, sourceId: "sim:liq" },
    },
    failures: [],
    codeVersion: "1.54.0-test",
    errorCode: null,
    startedAt: NOW,
    finishedAt: NOW,
  };
  const commit: PerpCommit = {
    run,
    batch: { funding, openInterest: oi as never, liquidations: liquidations as never },
    cursors: [],
  };
  const result = await store.commitRun(commit);
  return { store, funding, oi, liquidations, commitResult: result };
}

describe("perp query: as-of-Grenze", () => {
  it("liefert Zeilen mit available_at > asOf nicht — auch nicht als neueste", async () => {
    const { store } = await seedStore({ lateRows: 1 });
    const asOf = NOW_MS;
    const response = await queryPerpSeries(
      store,
      { instruments: [BTC.id], kinds: ["funding"], asOfMs: asOf, fromMs: T0 - HOUR, toMs: NOW_MS + 24 * HOUR, limit: 50 },
      { config: config(), nowMs: asOf }
    );
    const series = response.series[0];
    assert.ok(series.rows.length >= 1);
    for (const row of series.rows) {
      assert.ok(row.availableAt.getTime() <= asOf, `Satz vom ${row.availableAt.toISOString()} war zu asOf noch nicht verfügbar`);
      assert.ok(row.eventTime.getTime() <= asOf);
    }
    // Der zuletzt geschriebene Satz (später verfügbar) ist der sichtbare Beweis:
    assert.equal(store.rows("funding").length, series.rows.length + 1);
  });

  it("filterRowsAsOf ist die doppelte Schicht direkt prüfbar", () => {
    const rows = [
      { eventTime: new Date(NOW_MS - HOUR), availableAt: new Date(NOW_MS - HOUR) },
      { eventTime: new Date(NOW_MS - HOUR), availableAt: new Date(NOW_MS + HOUR) },
      { eventTime: new Date(NOW_MS + HOUR), availableAt: new Date(NOW_MS + HOUR) },
    ];
    assert.deepEqual(filterRowsAsOf(rows, NOW_MS).map((row) => row.availableAt.getTime()), [NOW_MS - HOUR]);
  });

  it("begrenzt die Antwort und meldet die Kappung", async () => {
    const { store } = await seedStore({ fundingCount: 6 });
    const response = await queryPerpSeries(
      store,
      { instruments: [BTC.id], kinds: ["funding"], asOfMs: NOW_MS, limit: 2 },
      { config: config(), nowMs: NOW_MS }
    );
    assert.equal(response.series[0].rows.length, 2);
    assert.equal(response.series[0].truncated, true, "Kappung wird gemeldet, nicht verschluckt");
    assert.equal(response.series[0].reason, PERP_QUERY_REASONS.TRUNCATED_BY_LIMIT);
  });

  it("ohne Treffer: MISSING mit Grund, nie eine leere Erfolgsmeldung", async () => {
    const { store } = await seedStore({ fundingCount: 1 });
    const response = await queryPerpSeries(
      store,
      { instruments: [BTC.id], kinds: ["funding"], asOfMs: T0 - 30 * 24 * HOUR, fromMs: null, toMs: null, limit: 10 },
      { config: config(), nowMs: NOW_MS }
    );
    assert.equal(response.series[0].availability, "MISSING");
    assert.equal(response.series[0].rows.length, 0);
    assert.equal(response.series[0].ageMs, null, "ohne Zeile kein Alter zu berichten");
  });

  it("validiert die Anfrage hart (Instrumente, Grenzen, Fenster, as-of)", () => {
    const cfg = config();
    assert.throws(() => validateAsOfRequest({ instruments: [], asOfMs: NOW_MS }, cfg, NOW_MS), (error: unknown) => (error as PerpQueryError).code === "query:instruments_required");
    assert.throws(
      () => validateAsOfRequest({ instruments: Array.from({ length: PERP_LIMITS.queryInstruments + 1 }, (_, i) => `SIM:SYM${i}`), asOfMs: NOW_MS }, cfg, NOW_MS),
      (error: unknown) => (error as PerpQueryError).code === "query:too_many_instruments"
    );
    // Ein Limit über der harten Kappe wird gekappt, nicht abgelehnt — die
    // Antwort meldet die Kappung (eigener Test oben).
    assert.equal(
      validateAsOfRequest({ instruments: [BTC.id], asOfMs: NOW_MS, limit: PERP_LIMITS.queryRowsPerSeries + 1 }, cfg, NOW_MS).limit,
      PERP_LIMITS.queryRowsPerSeries
    );
    assert.throws(
      () => validateAsOfRequest({ instruments: [BTC.id], asOfMs: NOW_MS, fromMs: NOW_MS, toMs: NOW_MS - HOUR }, cfg, NOW_MS),
      (error: unknown) => (error as PerpQueryError).code === "query:window_inverted"
    );
    assert.throws(
      () => validateAsOfRequest({ instruments: [BTC.id], asOfMs: NOW_MS + 10 * HOUR }, cfg, NOW_MS),
      (error: unknown) => (error as PerpQueryError).code === "query:asof_in_future"
    );
    assert.throws(
      () => validateAsOfRequest({ instruments: [BTC.id], asOfMs: NOW_MS, limit: 0 }, cfg, NOW_MS),
      (error: unknown) => (error as PerpQueryError).code === "query:limit_invalid"
    );
    assert.throws(
      () => validateAsOfRequest({ instruments: ["SIM/../etc/passwd"], asOfMs: NOW_MS }, cfg, NOW_MS),
      (error: unknown) => (error as PerpQueryError).code === "query:invalid_instrument"
    );
  });

  it("latestPerpRows liefert je Reihe den neuesten zulässigen Satz", async () => {
    const { store } = await seedStore({ fundingCount: 3 });
    const rows = await latestPerpRows(store, { instruments: [BTC.id], asOfMs: NOW_MS }, { config: config(), nowMs: NOW_MS });
    const funding = rows.find((entry) => entry.kind === "funding");
    assert.equal(funding?.rows[0]?.eventTime.getTime(), T0 + 2 * INTERVAL, "der neueste Satz zuerst");
  });
});

describe("perp consumers: Derivatekontext", () => {
  it("baut Satz, Raster, OI und Δ24h aus der kanonischen Ablage", async () => {
    const { store } = await seedStore({
      fundingCount: 2,
      oiSeries: [
        { ageHours: 1, quote: 6_600_000 },
        { ageHours: 24, quote: 6_000_000 },
      ],
    });
    const snapshots = await buildPerpDerivativeSnapshots({
      source: store,
      config: config(),
      instruments: [BTC],
      asOfMs: NOW_MS,
    });
    const snapshot = snapshots.get(BTC.id)!;
    assert.equal(snapshot.availability, "AVAILABLE");
    assert.equal(snapshot.fundingRate, 0.0002, "der neueste zulässige Satz gewinnt");
    assert.equal(snapshot.fundingIntervalHours, 8);
    assert.equal(snapshot.openInterest, 6_600_000, "Derivatekontext ist in Quote-Einheit vertraglich");
    assert.equal(snapshot.openInterestBasis, "quote_units");
    assert.ok(
      Math.abs((snapshot.openInterestChange24h ?? 0) - 0.1) < 1e-9,
      `Δ24h aus zwei Punkten (erwartet 0.1), war ${String(snapshot.openInterestChange24h)}`
    );
    const context = perpSnapshotToDerivativeContext(snapshot);
    assert.deepEqual(context, {
      fundingRate: snapshot.fundingRate,
      fundingIntervalHours: snapshot.fundingIntervalHours,
      openInterest: snapshot.openInterest,
      openInterestChange24h: snapshot.openInterestChange24h,
    });
  });

  it("nutzt eine OI-Größe nicht, die nur in Basis-Einheit autoritativ ist", async () => {
    // Die Venue meldet Basis-Menge und einen Quote-Betrag, aber keine
    // Marktpreis-Ableitung. Der Scanner-Kontext verlangt Quote — also: null mit
    // Grund, statt einer still umgedeuteten Zahl mit richtiger Optik.
    const { store } = await seedStore({ fundingCount: 3, oiBaseUnitsOnly: true });
    const snapshots = await buildPerpDerivativeSnapshots({ source: store, config: config(), instruments: [BTC], asOfMs: NOW_MS });
    const snapshot = snapshots.get(BTC.id)!;
    assert.equal(snapshot.openInterest, null);
    assert.match(snapshot.reasons.openInterest, /OI_NOT_REPORTED_IN_QUOTE_UNITS/);
    const context = perpDerivativeProvider(snapshots)(BTC);
    assert.notEqual(context, null, "Funding ist da ⇒ der Kontext existiert");
    assert.equal(context?.openInterest, null, "der OI-Faktor sieht null, nicht 0");
    assert.ok((context?.fundingRate ?? 0) > 0);
  });

  it("ohne Daten: Verfügbarkeit MISSING mit Grund, Kontext null (nie 0)", async () => {
    const store = new InMemoryPerpStore();
    const snapshots = await buildPerpDerivativeSnapshots({ source: store, config: config(), instruments: [BTC], asOfMs: NOW_MS });
    const snapshot = snapshots.get(BTC.id)!;
    assert.equal(snapshot.availability, "MISSING");
    assert.equal(snapshot.fundingRate, null);
    assert.equal(snapshot.openInterest, null);
    assert.ok(snapshot.reasons.funding.length > 0, "der Grund ist Teil des Vertrags");
    // Das Mapping selbst trägt die null-Felder aus (kein `0`); die
    // Provider-Grenze zum Scanner macht daraus `null` — „kein Kontext“ ist
    // dort die Vertragssprache der Faktoren.
    assert.deepEqual(perpSnapshotToDerivativeContext(snapshot), {
      fundingRate: null,
      fundingIntervalHours: null,
      openInterest: null,
      openInterestChange24h: null,
    });
    assert.equal(perpSnapshotToDerivativeContext(null), null, "kein Snapshot ⇒ kein Kontext");
    const provider = perpDerivativeProvider(snapshots);
    assert.equal(provider(BTC), null);
    const lines = perpAnalystSnapshotLines([snapshot]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /unavailable \(/);
    assert.equal(lines[0].includes("0.0000 %"), false, "keine erfundene 0-%-Rate im Analystentext");
  });

  it("unerreichbare Ablage: UNAVAILABLE + STORE_UNAVAILABLE (kein leerer Erfolg)", async () => {
    const broken = {
      async readFunding() {
        throw new Error("Perp-Ablage nicht erreichbar (readFunding): connection refused");
      },
      async readOpenInterest() {
        throw new Error("Perp-Ablage nicht erreichbar (readOpenInterest): connection refused");
      },
      async readLiquidations() {
        throw new Error("Perp-Ablage nicht erreichbar (readLiquidations): connection refused");
      },
    };
    const snapshots = await buildPerpDerivativeSnapshots({ source: broken, config: config(), instruments: [BTC], asOfMs: NOW_MS });
    const snapshot = snapshots.get(BTC.id)!;
    assert.equal(snapshot.availability, "UNAVAILABLE");
    assert.match(snapshot.reasons.funding, /STORE_UNAVAILABLE/);
    assert.equal(perpDerivativeProvider(snapshots)(BTC), null);
  });

  it("Staleness: zu alter Satz wird STALE, der Wert bleibt aber lesbar markiert", async () => {
    const { store } = await seedStore({ fundingCount: 1, intervalMs: HOUR, baseMs: NOW_MS - 5 * HOUR });
    const snapshots = await buildPerpDerivativeSnapshots({
      source: store,
      config: config({ PERP_DATA_MAX_STALE_FUNDING_HOURS: "1" }),
      instruments: [BTC],
      asOfMs: NOW_MS,
    });
    const snapshot = snapshots.get(BTC.id)!;
    assert.equal(snapshot.availability, "STALE");
    assert.ok(snapshot.fundingRate !== null, "der letzte Satz ist nicht gelöscht, nur als veraltet gekennzeichnet");
    assert.ok(snapshot.fundingAgeMs !== null && snapshot.fundingAgeMs > HOUR);
  });
});

describe("perp consumers: Funding-Replay", () => {
  it("bucht nur fällige Settlements der Haltedauer", async () => {
    const { store } = await seedStore({ fundingCount: 5 });
    const openedAt = T0 + INTERVAL;
    const closedAt = T0 + 3 * INTERVAL;
    const replay = await replayPositionFunding(store, {
      venue: "SIM",
      instrumentId: BTC.id,
      position: { symbol: BTC.symbol, side: "LONG", qty: 1, price: 66_000, openedAtMs: openedAt, closedAtMs: closedAt, isPerpetual: true },
      asOfMs: NOW_MS,
      config: config(),
    });
    const times = replay.entries.map((entry) => Date.parse(entry.eventTime));
    assert.ok(replay.entries.length >= 1);
    assert.equal(times.every((ms) => ms > openedAt && ms <= closedAt), true, `nur Settlements in der Haltedauer, waren ${times.map((ms) => new Date(ms).toISOString())}`);
    assert.equal(replay.hiddenRows, 0);
    assert.equal(replay.availability, "AVAILABLE");
    for (const entry of replay.entries) {
      assert.equal(entry.side, "LONG");
      assert.ok(entry.funding <= 0, "positiver Satz = Longs zahlen ⇒ Cashflow negativ (Kontosicht)");
      assert.ok(
        Math.abs(entry.funding + entry.ratePer8h * (entry.intervalHours / 8) * entry.notional) < 1e-9,
        "Cashflow = Satz × Intervall-Anteil × Notional (Kontosicht)"
      );
    }
  });

  it("offene Position: das Settlement nach `asOf` wird nicht gebucht", () => {
    const rows = [
      normalizeFundingRow({ eventTime: NOW_MS - 2 * INTERVAL, fundingRate: 0.0002, intervalHours: 8 }, 0, ctx()).row!,
      normalizeFundingRow({ eventTime: NOW_MS + INTERVAL, fundingRate: 0.0009, intervalHours: 8 }, 1, ctx()).row!,
    ];
    const replay = computeReplayAccruals(
      { symbol: BTC.symbol, side: "SHORT", qty: 2, price: 66_000, openedAtMs: NOW_MS - 3 * INTERVAL, isPerpetual: true },
      rows,
      { asOfMs: NOW_MS, defaultIntervalHours: 8 }
    );
    assert.equal(replay.entries.length, 1, "nur das fällige Settlement");
    assert.ok(replay.hiddenRows >= 1, "der Blick in die Zukunft wird gezählt");
    assert.ok(replay.entries.every((entry) => Date.parse(entry.eventTime) <= NOW_MS));
    assert.ok(replay.entries[0].funding >= 0, "Short erhält den Satz (Vorzeichen der Kontosicht)");
  });

  it("berechnet 8h-Norm nur mit dem gemeldeten Intervall", () => {
    assert.deepEqual(fundingRateTo8h(0.0003, 4, 8), { ratePer8h: 0.0006, intervalHours: 4 });
    assert.deepEqual(fundingRateTo8h(0.0003, null, 8), { ratePer8h: 0.0003, intervalHours: 8 });
    assert.deepEqual(fundingRateTo8h(0.0003, 0, 8), { ratePer8h: 0.0003, intervalHours: 8 }, "Raster 0 ist kein Teiler");
  });

  it("Funding-Rate-Provider für die Backtest-Engine: as-of, mit Treffer/Zähler", async () => {
    const { store } = await seedStore({ fundingCount: 3 });
    const provider = createPerpFundingRateProvider({
      source: store,
      config: config(),
      instrumentOf: (symbol) => (symbol === BTC.id || symbol === BTC.symbol ? BTC : null),
      warn: () => undefined,
    });
    await provider.load({ symbols: [BTC.id], fromMs: T0 - HOUR, toMs: NOW_MS });
    assert.ok(Math.abs((provider.getFundingRate(BTC.id, NOW_MS) ?? 0) - 0.0003) < 1e-12, "neuester bekannter Satz, auf 8h normiert");
    assert.equal(provider.getFundingRate(BTC.id, T0 - HOUR), null, "vor dem ersten Settlement gibt es nichts");
    const stats = provider.stats();
    assert.equal(stats.symbols, 1);
    assert.ok(stats.hits >= 1 && stats.misses >= 1);
  });
});

describe("perp consumers: Derivat-Artefakt (Scanner/Analyst)", () => {
  it("schreibt und liest das Artefakt atomar (0600) inkl. Gründe", async () => {
    const { store } = await seedStore({ fundingCount: 2, oiCount: 3 });
    const snapshots = await buildPerpDerivativeSnapshots({ source: store, config: config(), instruments: [BTC], asOfMs: NOW_MS });
    const dir = mkdtempSync(path.join(tmpdir(), "perp-cache-"));
    const file = path.join(dir, "derivatives.json");
    const cache = buildPerpDerivativeCache(snapshots.values(), {
      writtenAt: NOW,
      availabilityPolicy: "ingested",
      qualityMode: "log",
    });
    savePerpDerivativeCache(cache, file);
    assert.equal(readFileSync(file, "utf8").includes(BTC.id), true);
    const mode = (await import("node:fs")).statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, "das Artefakt ist nicht weltlesbar");
    const loaded = loadPerpDerivativeCache({ nowMs: NOW_MS, maxAgeMs: 24 * HOUR, file, env: { PERP_DATA_ENABLED: "true" } });
    assert.equal(loaded.reason, null);
    assert.equal(loaded.entries, 1);
    assert.equal(loaded.cache?.entries[BTC.id].fundingRate, cache.entries[BTC.id].fundingRate);
    const contexts = perpDerivativeContextsFromCache({ nowMs: NOW_MS, maxAgeMs: 24 * HOUR, file, env: { PERP_DATA_ENABLED: "true" } });
    assert.equal(contexts.map?.get(BTC.id)?.fundingRate, cache.entries[BTC.id].fundingRate);
    // Analystenzeilen aus demselben Artefakt (kein DB-Zugriff im Analystenpfad).
    const lines = perpAnalystSnapshotLinesFromCache({ file, nowMs: NOW_MS, maxAgeMs: 24 * HOUR, env: { PERP_DATA_ENABLED: "true" } });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /funding/);
  });

  it("bleibt bei gesperrtem Flag komplett ungelesen (Scanner wie vor v1.54.0)", async () => {
    const { store } = await seedStore({ fundingCount: 1 });
    const snapshots = await buildPerpDerivativeSnapshots({ source: store, config: config(), instruments: [BTC], asOfMs: NOW_MS });
    const dir = mkdtempSync(path.join(tmpdir(), "perp-cache-"));
    const file = path.join(dir, "derivatives.json");
    savePerpDerivativeCache(buildPerpDerivativeCache(snapshots.values(), { writtenAt: NOW, availabilityPolicy: "ingested", qualityMode: "log" }), file);
    const disabled = perpDerivativeContextsFromCache({ file, env: { PERP_DATA_ENABLED: "false" }, nowMs: NOW_MS });
    assert.equal(disabled.map, null);
    assert.equal(disabled.reason, "DISABLED");
    assert.equal(perpAnalystSnapshotLinesFromCache({ file, env: { PERP_DATA_ENABLED: "false" }, nowMs: NOW_MS }).length, 0);
  });

  it("verwirft ein zu altes und ein unlesbares Artefakt (statt Alt-Werte zu nutzen)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "perp-cache-"));
    const file = path.join(dir, "derivatives.json");
    const cache = buildPerpDerivativeCache(
      [{
        instrumentId: BTC.id,
        venue: "SIM",
        symbol: BTC.symbol,
        availability: "AVAILABLE",
        reasons: { funding: "OK", openInterest: "OK", liquidations: "OK" },
        fundingRate: 0.0001,
        fundingIntervalHours: 8,
        fundingEventTime: NOW.toISOString(),
        fundingAgeMs: 0,
        nextFundingTime: null,
        openInterest: 100,
        openInterestBasis: "base_units",
        openInterestChange24h: 0.01,
        openInterestAgeMs: 0,
        liquidationEvents: 1,
        liquidationNotionalQuote: 33_000,
        asOf: NOW.toISOString(),
      }],
      { writtenAt: new Date(NOW_MS - 30 * HOUR), availabilityPolicy: "ingested", qualityMode: "log" }
    );
    savePerpDerivativeCache(cache, file);
    const stale = loadPerpDerivativeCache({ file, nowMs: NOW_MS, maxAgeMs: 24 * HOUR, env: { PERP_DATA_ENABLED: "true" } });
    assert.equal(stale.reason, "FILE_STALE");
    assert.equal(stale.cache, null);
    assert.equal(perpDerivativeContextsFromCache({ file, nowMs: NOW_MS, maxAgeMs: 24 * HOUR, env: { PERP_DATA_ENABLED: "true" } }).map, null);

    writeFileSync(file, "{ kein json", { mode: 0o600 });
    const broken = loadPerpDerivativeCache({ file, nowMs: NOW_MS, env: { PERP_DATA_ENABLED: "true" } });
    assert.equal(broken.reason, "FILE_INVALID");
    assert.equal(broken.cache, null);
  });

  it("begrenzt die Einträge auf das Abfragebudget", () => {
    const many = Array.from({ length: PERP_LIMITS.queryInstruments + 25 }, (_, index) => ({
      instrumentId: `SIM:SYM${index}`,
      venue: "SIM",
      symbol: `SYM${index}`,
      availability: "AVAILABLE" as const,
      reasons: { funding: "OK", openInterest: "OK", liquidations: "OK" },
      fundingRate: 0.0001,
      fundingIntervalHours: 8,
      fundingEventTime: NOW.toISOString(),
      fundingAgeMs: 0,
      nextFundingTime: null,
      openInterest: 1,
      openInterestBasis: "contracts" as const,
      openInterestChange24h: null,
      openInterestAgeMs: 0,
      liquidationEvents: null,
      liquidationNotionalQuote: null,
      asOf: NOW.toISOString(),
    }));
    const cache = buildPerpDerivativeCache(many, { writtenAt: NOW, availabilityPolicy: "ingested", qualityMode: "log" });
    assert.equal(Object.keys(cache.entries).length, PERP_LIMITS.queryInstruments);
  });
});

describe("perp consumers: Belegbarkeit schlägt Verfügbarkeit", () => {
  it("ein angezweifelter Satz liefert keinen Open-Interest-Wert — der Grund bleibt lesbar", async () => {
    const { store } = await seedStore({
      oiSeries: [
        { ageHours: 5, quote: 6_600_000 },
        { ageHours: 1, quote: 99_000_000 },
      ],
      oiFlags: [undefined, "INVALID"],
    });
    const snapshots = await buildPerpDerivativeSnapshots({
      source: store,
      config: config(),
      instruments: [BTC],
      asOfMs: NOW_MS,
    });
    const snapshot = snapshots.get(BTC.id)!;
    assert.equal(snapshot.openInterest, 6_600_000, "die ältere belegbare Zeile gewinnt, nicht die neueinge Zweifelhafte");
    assert.equal(snapshot.openInterestAgeMs, 5 * HOUR, "Alter gegen die Ereigniszeit der benutzten Zeile");
    assert.equal(perpSnapshotToDerivativeContext(snapshot)?.openInterest, 6_600_000);

    // Sind *alle* Sätze angezweifelt, bleibt der Wert null — mit Grund, nie
    // still: „die Reihe existiert, aber nichts daran ist belegbar“.
    const allFlagged = await seedStore({
      oiSeries: [
        { ageHours: 5, quote: 6_600_000 },
        { ageHours: 1, quote: 99_000_000 },
      ],
      oiFlags: ["INVALID", "CROSSCHECK"],
    });
    const flaggedSnapshot = (
      await buildPerpDerivativeSnapshots({
        source: allFlagged.store,
        config: config(),
        instruments: [BTC],
        asOfMs: NOW_MS,
      })
    ).get(BTC.id)!;
    assert.equal(flaggedSnapshot.openInterest, null, "unbelegbare Zahlen werden nicht zu Signalen");
    assert.equal(flaggedSnapshot.reasons.openInterest, "ALL_ROWS_UNATTESTABLE");
    assert.equal(perpSnapshotToDerivativeContext(flaggedSnapshot)?.openInterest, null);
  });

  it("ohne verfügbare Liquidationsreihe: null statt 0 (ruhiger Markt != keine Daten)", async () => {
    const quiet = await seedStore({ liquidationCount: 0 });
    const quietSnapshot = (
      await buildPerpDerivativeSnapshots({ source: quiet.store, config: config(), instruments: [BTC], asOfMs: NOW_MS })
    ).get(BTC.id)!;
    assert.equal(quietSnapshot.liquidationEvents, null, "keine Reihe ⇒ unbekannt, nicht „0 Ereignisse“");
    assert.equal(quietSnapshot.liquidationNotionalQuote, null);
    assert.match(quietSnapshot.reasons.liquidations, /NO_ROWS|UNATTESTABLE|STORE_UNAVAILABLE/);

    const noisy = await seedStore({ liquidationCount: 2 });
    const noisySnapshot = (
      await buildPerpDerivativeSnapshots({ source: noisy.store, config: config(), instruments: [BTC], asOfMs: NOW_MS })
    ).get(BTC.id)!;
    assert.equal(noisySnapshot.liquidationEvents, 2);
    assert.equal(noisySnapshot.liquidationNotionalQuote, 0.5 * 66_000 + 1.5 * 66_000);
  });

  it("Replay bucht aus einem angezweifelten Settlement nie eine Zahlung", () => {
    const row = normalizeFundingRow({ eventTime: NOW_MS - 2 * INTERVAL, fundingRate: 0.005, intervalHours: 8 }, 0, ctx()).row!;
    const position = { symbol: BTC.symbol, side: "LONG" as const, qty: 1, price: 66_000, openedAtMs: NOW_MS - 3 * INTERVAL, isPerpetual: true };

    const clean = computeReplayAccruals(position, [row], { asOfMs: NOW_MS, defaultIntervalHours: 8 });
    assert.equal(clean.entries.length, 1, "belegbarer Satz bucht");

    const flagged = computeReplayAccruals(position, [{ ...row, qualityStatus: "INVALID" }], { asOfMs: NOW_MS, defaultIntervalHours: 8 });
    assert.equal(flagged.entries.length, 0, "INVALID-Rate bucht nicht — auch nicht im log-Modus");
    assert.equal(flagged.qualityFlagged, 1, "der Ausschluss ist gezählt, nicht verschwunden");

    const stale = computeReplayAccruals(position, [{ ...row, qualityStatus: "STALE" }], { asOfMs: NOW_MS, defaultIntervalHours: 8 });
    assert.equal(stale.entries.length, 1, "Alter ist kein Zweifel an der Zahl selbst");
    const strict = computeReplayAccruals(position, [{ ...row, qualityStatus: "STALE" }], { asOfMs: NOW_MS, defaultIntervalHours: 8, strictQuality: true });
    assert.equal(strict.entries.length, 0, "strict verlangt OK");
  });
});
