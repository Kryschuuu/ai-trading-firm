/**
 * Tests der Sektion „Market Data“ (OPS-011): `collectMarketDataReadiness()`
 * baut den `MarketDataOpsSnapshot` als **reine Lesefunktion** — Registry-Query,
 * Historical-Store-Zählung, Readiness-Ableitung und zwischengespeicherte
 * Sync-Ergebnisse. Kein Netzwerk-I/O, kein Sync-Trigger.
 *
 * Abgedeckt (Ticket §4):
 *   1  leerer Historical Store  → dataReady 0
 *   2  Grenzwert: exakt requiredCandles zählt als data-ready
 *   3  tickerReady zählt nur volume24h ≠ null
 *   4  spreadReady zählt nur spread ≠ null
 *   5  scannerReady ⇔ readinessStatus === READY
 *   6  worstOffenders deterministisch, candles asc, max. 10
 *   7  venues aggregieren failuresByReason aus Sync-Ergebnissen
 *   8  kein Netzwerk-I/O (globaler fetch-Spy = 0)
 *   9  Hint je dominierendem Blocker (Table-Test, 5 Szenarien)
 *  10  Snapshot ist JSON-serialisierbar und stabil
 *  15  Integration: Fake-Sync, 2 von 3 Instrumenten gewärmt
 *  Security: keine Secrets/Env-Werte/Stacktraces im Snapshot,
 *  geschlossene reason-Aufzählung im persistierten Sync-Status.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { scanTextForSecrets } from "../../src/brokers/control-plane/secretScan";
import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";
import {
  loadVenueSyncStatuses,
  saveVenueSyncStatus,
  syncResultToVenueStatus,
  type VenueSyncStatus,
} from "../../src/marketdata/syncStatus";
import type { SyncResult } from "../../src/marketdata/types";
import {
  buildReadinessHint,
  collectMarketDataReadiness,
  MAX_SNAPSHOT_OFFENDERS,
  type MarketDataSnapshotInput,
} from "../../src/ops/collectMarketData";
import { scannerCandleCounts } from "../../src/ops/marketDataReadiness";
import type { MarketDataOpsSnapshot } from "../../src/ops/types";
import { loadScannerConfig } from "../../src/scanner/config";
import { requiredWarmupCandles } from "../../src/scanner/warmup";
import { AS_OF, AS_OF_MS, candlesFromCloses, instrument } from "../../tests/fixtures/scannerFixtures";
import type { MarketInstrument } from "../../src/universe/types";

const CONFIG = loadScannerConfig();
const REQUIRED = requiredWarmupCandles(CONFIG); // 61 bei Default-Faktorsatz

/** Drei deterministische Instrumente (Ticker + Spread vollständig). */
function universe(): MarketInstrument[] {
  return [
    instrument({ venue: "BITUNIX", symbol: "BTCUSDT", lastSeen: AS_OF }),
    instrument({ venue: "BITUNIX", symbol: "ETHUSDT", base: "ETH", lastSeen: AS_OF }),
    instrument({ venue: "BITUNIX", symbol: "SOLUSDT", base: "SOL", lastSeen: AS_OF }),
  ];
}

function counts(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

function snapshotInput(overrides: Partial<MarketDataSnapshotInput> = {}): MarketDataSnapshotInput {
  return {
    instruments: universe(),
    candleCounts: counts({}),
    config: CONFIG,
    now: AS_OF_MS,
    ...overrides,
  };
}

/** Fake-`SyncResult` (nur die vom Status genutzten Felder sind relevant). */
function fakeSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    venue: "BITUNIX",
    startedAt: AS_OF,
    finishedAt: AS_OF,
    discovered: 3,
    synced: 3,
    skipped: 0,
    tickersEnriched: 3,
    orderbooksEnriched: 3,
    spreadsUnknown: 0,
    policyExcluded: 0,
    candlesByTimeframe: { "1h": { instruments: 3, bars: 450 } },
    failures: [],
    degraded: false,
    durationMs: 1000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Zähler
// ─────────────────────────────────────────────────────────────────────────────

test("snapshot reports 0 data-ready for empty history", () => {
  const s = collectMarketDataReadiness(snapshotInput());
  assert.equal(s.registry, 3);
  assert.equal(s.discovered, 3);
  assert.equal(s.dataReady, 0);
  assert.equal(s.warming, 3);
  assert.equal(s.requiredCandles, REQUIRED);
  assert.equal(s.readinessStatus, "WARMING");
  assert.equal(s.scannerReady, false);
});

test("snapshot counts an instrument as data-ready at exactly requiredCandles", () => {
  const s = collectMarketDataReadiness(
    snapshotInput({
      candleCounts: counts({
        "BITUNIX:BTCUSDT": REQUIRED, // Grenzwert: zählt als ready
        "BITUNIX:ETHUSDT": REQUIRED - 1, // eine Kerze zu wenig: zählt nicht
        "BITUNIX:SOLUSDT": REQUIRED + 50,
      }),
    }),
  );
  assert.equal(s.dataReady, 2);
  assert.equal(s.warming, 1);
  assert.deepEqual(
    s.worstOffenders.map((o) => o.instrumentId),
    ["BITUNIX:ETHUSDT"],
  );
});

test("tickerReady counts only instruments with non-null volume24h", () => {
  const instruments = universe();
  instruments[0].volume24h = null;
  instruments[1].volume24h = 0; // 0 ist ein bekannter Wert, kein „unbekannt“
  const s = collectMarketDataReadiness(snapshotInput({ instruments }));
  assert.equal(s.tickerReady, 2);
});

test("spreadReady counts only instruments with non-null spread", () => {
  const instruments = universe();
  instruments[0].spread = null;
  instruments[2].spread = null;
  const s = collectMarketDataReadiness(snapshotInput({ instruments }));
  assert.equal(s.spreadReady, 1);
});

test("scannerReady is true only when readinessStatus === READY", () => {
  const full = counts({
    "BITUNIX:BTCUSDT": REQUIRED,
    "BITUNIX:ETHUSDT": REQUIRED,
    "BITUNIX:SOLUSDT": REQUIRED,
  });

  const ready = collectMarketDataReadiness(snapshotInput({ candleCounts: full }));
  assert.equal(ready.readinessStatus, "READY");
  assert.equal(ready.scannerReady, true);

  // WARMING (Spread fehlt) → nicht scanner-ready, obwohl Kerzen vollständig sind
  const noSpread = universe().map((i) => ({ ...i, spread: null }));
  const warming = collectMarketDataReadiness(snapshotInput({ instruments: noSpread, candleCounts: full }));
  assert.equal(warming.readinessStatus, "WARMING");
  assert.equal(warming.scannerReady, false);

  // ERROR (Fehler-Manifest) → nie scanner-ready, selbst mit voller Historie
  const error = collectMarketDataReadiness(
    snapshotInput({ candleCounts: full, dataErrors: new Map([["BITUNIX:BTCUSDT", "RATE_LIMITED"]]) }),
  );
  assert.equal(error.readinessStatus, "ERROR");
  assert.equal(error.scannerReady, false);
});

test("worstOffenders is deterministic, sorted asc by candles, capped at 10", () => {
  const instruments = Array.from({ length: 15 }, (_, i) =>
    instrument({ venue: "BITUNIX", symbol: `SYM${String(i).padStart(2, "0")}USDT`, lastSeen: AS_OF }),
  );
  const candleCounts = new Map(instruments.map((ins, i) => [ins.id, i])); // 0..14 Kerzen
  const a = collectMarketDataReadiness(snapshotInput({ instruments, candleCounts }));
  const b = collectMarketDataReadiness(
    snapshotInput({ instruments: [...instruments].reverse(), candleCounts }),
  );

  assert.equal(a.worstOffenders.length, MAX_SNAPSHOT_OFFENDERS);
  assert.deepEqual(a.worstOffenders, b.worstOffenders, "Reihenfolge der Eingabe darf nichts ändern");
  const candleSeq = a.worstOffenders.map((o) => o.candles);
  assert.deepEqual(candleSeq, [...candleSeq].sort((x, y) => x - y), "candles aufsteigend");
  assert.equal(a.worstOffenders[0].instrumentId, "BITUNIX:SYM00USDT");
  assert.ok(a.worstOffenders.every((o) => o.required === REQUIRED));
});

// ─────────────────────────────────────────────────────────────────────────────
// Venues / Sync-Status
// ─────────────────────────────────────────────────────────────────────────────

test("venues section aggregates failuresByReason from sync results", () => {
  const result = fakeSyncResult({
    degraded: true,
    failures: [
      { stage: "candles", instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h", message: "x", reason: "RATE_LIMITED" },
      { stage: "candles", instrumentId: "BITUNIX:ETHUSDT", timeframe: "1h", message: "x", reason: "RATE_LIMITED" },
      { stage: "ticker", instrumentId: "BITUNIX:SOLUSDT", message: "x", reason: "UPSTREAM_5XX" },
      { stage: "discovery", message: "roher upstream text der nie durchgereicht wird" }, // ohne reason → UNKNOWN
    ],
  });
  const status = syncResultToVenueStatus(result);
  assert.deepEqual(status.failuresByReason, { RATE_LIMITED: 2, UPSTREAM_5XX: 1, UNKNOWN: 1 });
  assert.equal(status.lastSyncDegraded, true);

  const s = collectMarketDataReadiness(snapshotInput({ syncStatuses: [status] }));
  assert.equal(s.venues.length, 1);
  assert.equal(s.venues[0].venue, "BITUNIX");
  assert.equal(s.venues[0].lastSyncAt, AS_OF);
  assert.equal(s.venues[0].lastSyncDegraded, true);
  assert.equal(s.venues[0].instruments, 3);
  assert.deepEqual(s.venues[0].failuresByReason, { RATE_LIMITED: 2, UPSTREAM_5XX: 1, UNKNOWN: 1 });
  // Keine rohe Upstream-Message wandert in den Snapshot:
  assert.ok(!JSON.stringify(s).includes("roher upstream text"));
});

test("persisted sync status roundtrips with a closed reason enum", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sync-status-"));
  const file = path.join(dir, "market-sync-status.json");
  try {
    saveVenueSyncStatus(
      fakeSyncResult({
        degraded: true,
        failures: [{ stage: "candles", instrumentId: "BITUNIX:BTCUSDT", message: "x", reason: "TIMEOUT" }],
      }),
      file,
      new Date(AS_OF),
    );
    saveVenueSyncStatus(fakeSyncResult({ venue: "PAPER", synced: 26 }), file, new Date(AS_OF));

    const loaded = loadVenueSyncStatuses(file);
    assert.deepEqual(
      loaded.map((v) => v.venue),
      ["BITUNIX", "PAPER"],
      "deterministisch sortiert, beide Venues erhalten",
    );
    assert.deepEqual(loaded[0].failuresByReason, { TIMEOUT: 1 });

    // Manipulierte Datei mit unbekanntem reason-Schlüssel → Eintrag wird verworfen
    const tampered: VenueSyncStatus = {
      ...loaded[0],
      failuresByReason: { "<script>alert(1)</script>": 3, TIMEOUT: 1 } as Record<string, number>,
    };
    writeFileSync(file, JSON.stringify({ writtenAt: AS_OF, venues: [tampered] }));
    const reloaded = loadVenueSyncStatuses(file);
    assert.deepEqual(reloaded[0].failuresByReason, { TIMEOUT: 1 }, "geschlossene Aufzählung erzwungen");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Kein Netzwerk-I/O
// ─────────────────────────────────────────────────────────────────────────────

test("collectMarketDataReadiness performs no network I/O", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;
  try {
    collectMarketDataReadiness(snapshotInput());
    collectMarketDataReadiness(
      snapshotInput({ dataErrors: new Map([["BITUNIX:BTCUSDT", "NETWORK"]]), syncStatuses: [] }),
    );
    assert.equal(fetchCalls, 0, "die Aggregation darf fetch nie aufrufen");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Hint-Engine (Table-Test über alle fünf Szenarien)
// ─────────────────────────────────────────────────────────────────────────────

test("hint text matches the dominant blocker", () => {
  const full = counts({
    "BITUNIX:BTCUSDT": REQUIRED,
    "BITUNIX:ETHUSDT": REQUIRED,
    "BITUNIX:SOLUSDT": REQUIRED,
  });
  const cases: { name: string; input: MarketDataSnapshotInput; expect: (hint: string, s: MarketDataOpsSnapshot) => void }[] = [
    {
      name: "ERROR → Infrastruktur, häufigste Ursache benannt",
      input: snapshotInput({
        dataErrors: new Map([["BITUNIX:BTCUSDT", "RATE_LIMITED"]]),
        syncStatuses: [
          {
            venue: "BITUNIX",
            lastSyncAt: AS_OF,
            lastSyncDegraded: true,
            instruments: 3,
            failuresByReason: { RATE_LIMITED: 5, TIMEOUT: 1 },
          },
        ],
      }),
      expect: (hint, s) => {
        assert.equal(s.readinessStatus, "ERROR");
        assert.match(hint, /haeufigste Ursache: RATE_LIMITED/);
        assert.match(hint, /Infrastrukturproblem, keine Marktbewertung/);
        assert.match(hint, /Venue-Status und Request-Budget/);
      },
    },
    {
      name: "WARMING ohne Kerzen → Sync-Kommando + Herleitung des Sollwerts",
      input: snapshotInput(),
      expect: (hint, s) => {
        assert.equal(s.readinessStatus, "WARMING");
        assert.match(hint, /keine Kerzenhistorie/);
        assert.match(hint, /npm run market:sync -- --venue=BITUNIX/);
        assert.match(hint, new RegExp(`${REQUIRED} Kerzen je Instrument`));
        assert.match(hint, /EMA50/);
        assert.match(hint, /Momentum-Lookback von 60 Perioden/);
      },
    },
    {
      name: "WARMING mit Kerzen, aber ohne Spread → depth-Enrichment",
      input: snapshotInput({
        instruments: universe().map((i) => ({ ...i, spread: null })),
        candleCounts: full,
      }),
      expect: (hint, s) => {
        assert.equal(s.readinessStatus, "WARMING");
        assert.equal(s.spreadReady, 0);
        assert.match(hint, /Kerzen sind vorhanden, aber kein Spread/);
        assert.match(hint, /market\/depth/);
        assert.match(hint, /rule=max-spread/);
        assert.match(hint, /Datenqualitaet, nicht Marktqualitaet/);
      },
    },
    {
      name: "WARMING teilweise → fehlende Instrumente werden benannt",
      input: snapshotInput({
        candleCounts: counts({
          "BITUNIX:BTCUSDT": REQUIRED,
          "BITUNIX:ETHUSDT": REQUIRED,
          "BITUNIX:SOLUSDT": 10,
        }),
      }),
      expect: (hint, s) => {
        assert.equal(s.readinessStatus, "WARMING");
        assert.match(hint, /Warmup unvollstaendig: 1 von 3/);
        assert.match(hint, new RegExp(`BITUNIX:SOLUSDT \\(10/${REQUIRED} Kerzen\\)`));
        assert.match(hint, /datenbedingt, keine Marktbewertung/);
      },
    },
    {
      name: "READY → leerer Funnel ist eine fachliche Aussage",
      input: snapshotInput({ candleCounts: full }),
      expect: (hint, s) => {
        assert.equal(s.readinessStatus, "READY");
        assert.match(hint, /Datenbasis vollstaendig/);
        assert.match(hint, /echte fachliche Aussage/);
        assert.doesNotMatch(hint, /Infrastrukturproblem|market:sync|max-spread/);
      },
    },
  ];

  for (const c of cases) {
    const s = collectMarketDataReadiness(c.input);
    assert.equal(s.hint, buildReadinessHint(s), `${c.name}: hint muss aus buildReadinessHint stammen`);
    c.expect(s.hint, s);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Serialisierbarkeit + Security
// ─────────────────────────────────────────────────────────────────────────────

test("snapshot is JSON-serializable and stable", () => {
  const build = () =>
    collectMarketDataReadiness(
      snapshotInput({
        candleCounts: counts({ "BITUNIX:BTCUSDT": REQUIRED, "BITUNIX:ETHUSDT": 5 }),
        syncStatuses: [
          { venue: "BITUNIX", lastSyncAt: AS_OF, lastSyncDegraded: false, instruments: 3, failuresByReason: {} },
        ],
      }),
    );
  const s = build();
  const roundtrip = JSON.parse(JSON.stringify(s)) as MarketDataOpsSnapshot;
  assert.deepEqual(roundtrip, s, "JSON-Roundtrip verlustfrei");
  assert.deepEqual(build(), s, "gleiche Eingaben ⇒ identischer Snapshot (deterministisch)");

  // Snapshot-Test: exakte, stabile Struktur bei fixierter Uhr.
  assert.deepEqual(s, {
    generatedAt: AS_OF,
    requiredCandles: REQUIRED,
    registry: 3,
    discovered: 3,
    dataReady: 1,
    warming: 2,
    tickerReady: 3,
    spreadReady: 3,
    scannerReady: false,
    readinessStatus: "WARMING",
    venues: [
      { venue: "BITUNIX", lastSyncAt: AS_OF, lastSyncDegraded: false, instruments: 3, failuresByReason: {} },
    ],
    worstOffenders: [
      { instrumentId: "BITUNIX:SOLUSDT", candles: 0, required: REQUIRED },
      { instrumentId: "BITUNIX:ETHUSDT", candles: 5, required: REQUIRED },
    ],
    hint: s.hint,
  });
});

test("snapshot contains no secrets, env values, absolute paths or stack traces", () => {
  process.env.OPS_TEST_CANARY = "super-geheimer-wert-1234567890";
  try {
    const s = collectMarketDataReadiness(
      snapshotInput({
        dataErrors: new Map([["BITUNIX:BTCUSDT", "RATE_LIMITED"]]),
        syncStatuses: [
          {
            venue: "BITUNIX",
            lastSyncAt: AS_OF,
            lastSyncDegraded: true,
            instruments: 3,
            failuresByReason: { RATE_LIMITED: 1 },
          },
        ],
      }),
    );
    const text = JSON.stringify(s);
    assert.deepEqual(scanTextForSecrets(text), [], "Secret-Scanner muss leer bleiben");
    assert.ok(!text.includes(process.env.OPS_TEST_CANARY!), "keine Env-Werte im Snapshot");
    assert.ok(!/\/(home|Users|var|etc|tmp)\//.test(text), "keine absoluten Dateipfade");
    assert.ok(!text.includes("    at "), "keine Stacktraces");
  } finally {
    delete process.env.OPS_TEST_CANARY;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: Fake-Sync mit echtem Historical Store (Ticket §4, Test 15)
// ─────────────────────────────────────────────────────────────────────────────

test("integration: fake sync with 2 of 3 instruments fully warmed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ops-marketdata-"));
  try {
    const store = new HistoricalStore(path.join(dir, "history"));
    const instruments = universe();

    // Fake-Sync: 2 Instrumente vollständig (150 Kerzen), 1 unvollständig (10).
    const warmed = [instruments[0], instruments[1]];
    for (const target of warmed) {
      const candles = candlesFromCloses(Array.from({ length: 150 }, () => 100));
      const result = store.append(candles, target.id, { venue: target.venue, feed: "test:sync" }, "1h", new Date(AS_OF));
      assert.equal(result.written, 150);
    }
    const partial = candlesFromCloses(Array.from({ length: 10 }, () => 100));
    store.append(partial, instruments[2].id, { venue: "BITUNIX", feed: "test:sync" }, "1h", new Date(AS_OF));

    const statusFile = path.join(dir, "market-sync-status.json");
    saveVenueSyncStatus(fakeSyncResult(), statusFile, new Date(AS_OF));

    const s = collectMarketDataReadiness({
      instruments,
      candleCounts: scannerCandleCounts(store, instruments, CONFIG.factors.correlation.benchmarkInstrumentId),
      config: CONFIG,
      syncStatuses: loadVenueSyncStatuses(statusFile),
      now: AS_OF_MS,
    });

    assert.equal(s.dataReady, 2);
    assert.equal(s.warming, 1);
    assert.equal(s.scannerReady, false);
    assert.equal(s.readinessStatus, "WARMING");
    assert.match(s.hint, /BITUNIX:SOLUSDT/, "Hint nennt das fehlende Instrument");
    assert.equal(s.venues[0].venue, "BITUNIX");
    assert.equal(s.venues[0].lastSyncAt, AS_OF);
    assert.deepEqual(
      s.worstOffenders,
      [{ instrumentId: "BITUNIX:SOLUSDT", candles: 10, required: REQUIRED }],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
