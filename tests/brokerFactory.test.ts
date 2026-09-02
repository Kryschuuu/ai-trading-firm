/**
 * Factory-Tests (Task 02/07): DIE 28er-Matrix (7 Venues × 4 Modes) mit
 * expliziter Erwartungstabelle, Capability-Gating, Fehlerklassen,
 * Registry-Projektion, Audit-Vollständigkeit und Singleton-Semantik.
 *
 * Fail-Safe-Vertrag: Jede abgewiesene Kombination WIRFT — es gibt
 * keinen stillschweigenden Fallback auf Paper oder ein anderes Venue.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getBroker,
  normalizeVenue,
  paperBrokerLedger,
} from "../src/brokers/factory";
import { PaperBrokerAdapter } from "../src/brokers/paper";
import { StubBrokerAdapter } from "../src/brokers/stubs";
import { BitunixBrokerAdapter } from "../src/brokers/bitunix";
import { AlpacaBrokerAdapter } from "../src/brokers/alpaca";
import { VENUE_CAPABILITIES, REQUIRED_CAPABILITY_BY_MODE } from "../src/brokers/capabilities";
import {
  clearBrokerFactoryAuditForTests,
  readBrokerFactoryAudit,
} from "../src/brokers/audit";
import {
  BROKER_VENUE_IDS,
  EXECUTION_MODES,
  LiveTradingGateError,
  NotSupportedCapabilityError,
  UnknownVenueError,
  type BrokerVenueId,
  type ExecutionMode,
} from "../src/contracts/broker";
import { BROKER_REGISTRY } from "../src/lib/broker";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";

beforeEach(() => {
  resetRuntimeLimits();
  killSwitch.disarm();
  clearBrokerFactoryAuditForTests();
});

// ─────────────────────────────────────────────────────────────────────────────
// DIE ERWARTUNGSTABELLE: 7 Venues × 4 Modes = 28 Fälle
//
//   PAPER   : backtest ✓ · paper ✓ · testnet ✗(NSE testnet) · live ✗(LGTE)
//   BITUNIX : backtest ✓ · paper ✓ · testnet ✗(NSE testnet) · live ✗(LGTE)
//   ALPACA  : backtest ✓ · paper ✓ · testnet ✓ · live ✗(LGTE)     (Task 12)
//   IBKR    : backtest ✗ · paper ✗ · testnet ✗ · live ✗(LGTE)    (Stub)
//   BINANCE : wie IBKR
//   KRAKEN  : wie IBKR
//   DYDX    : wie IBKR
//
// Begründung: Stubs deklarieren alle Exec-Capabilities ehrlich false.
// BITUNIX kann Paper/Backtest (Modus B); ALPACA kann zusätzlich testnet
// (Paper-Trade-API ist Alpacas offizielles Testnet). `live` ist für JEDES
// Venue hart gesperrt (LiveTradingGateError) — unabhängig von Flags.
// ─────────────────────────────────────────────────────────────────────────────

type Expectation =
  | { ok: true }
  | { ok: false; error: "LIVE_TRADING_GATE" }
  | { ok: false; error: "NOT_SUPPORTED_CAPABILITY"; capability: string };

const stubRow = (venue: BrokerVenueId): Record<ExecutionMode, Expectation> => ({
  backtest: { ok: false, error: "NOT_SUPPORTED_CAPABILITY", capability: "paper" },
  paper: { ok: false, error: "NOT_SUPPORTED_CAPABILITY", capability: "paper" },
  testnet: { ok: false, error: "NOT_SUPPORTED_CAPABILITY", capability: "testnet" },
  live: { ok: false, error: "LIVE_TRADING_GATE" },
});

const MATRIX: Record<BrokerVenueId, Record<ExecutionMode, Expectation>> = {
  PAPER: {
    backtest: { ok: true },
    paper: { ok: true },
    testnet: { ok: false, error: "NOT_SUPPORTED_CAPABILITY", capability: "testnet" },
    live: { ok: false, error: "LIVE_TRADING_GATE" },
  },
  ALPACA: {
    backtest: { ok: true },
    paper: { ok: true },
    testnet: { ok: true },
    live: { ok: false, error: "LIVE_TRADING_GATE" },
  },
  IBKR: stubRow("IBKR"),
  BINANCE: stubRow("BINANCE"),
  KRAKEN: stubRow("KRAKEN"),
  DYDX: stubRow("DYDX"),
  BITUNIX: {
    backtest: { ok: true },
    paper: { ok: true },
    testnet: { ok: false, error: "NOT_SUPPORTED_CAPABILITY", capability: "testnet" },
    live: { ok: false, error: "LIVE_TRADING_GATE" },
  },
};

test("Matrix-Vollständigkeit: exakt 7 Venues × 4 Modes = 28 Einträge", () => {
  assert.deepEqual(
    Object.keys(MATRIX).sort(),
    [...BROKER_VENUE_IDS].sort(),
    "Die Matrix muss genau die 7 Adapter-Venues abdecken"
  );
  for (const venue of BROKER_VENUE_IDS) {
    assert.deepEqual(
      Object.keys(MATRIX[venue]).sort(),
      [...EXECUTION_MODES].sort(),
      `${venue}: alle 4 Modes vorhanden`
    );
  }
  assert.equal(Object.keys(MATRIX).length * EXECUTION_MODES.length, 28);
});

test("28er-Factory-Matrix: jeder Fall entspricht der Erwartungstabelle", async () => {
  for (const venue of BROKER_VENUE_IDS) {
    for (const mode of EXECUTION_MODES) {
      const expected = MATRIX[venue][mode];
      try {
        const adapter = await getBroker(venue, mode);
        assert.equal(expected.ok, true, `${venue}/${mode}: sollte liefern, wirft aber?`);
        assert.equal(adapter.id, venue, `${venue}/${mode}: id`);
        assert.equal(adapter.mode, mode, `${venue}/${mode}: mode`);
        assert.equal(
          adapter.capabilities,
          VENUE_CAPABILITIES[venue],
          `${venue}/${mode}: Capabilities = Capability-Table`
        );
        if (venue === "PAPER") {
          assert.ok(adapter instanceof PaperBrokerAdapter, `${venue}/${mode}: PAPER-Adapter`);
        } else if (venue === "BITUNIX") {
          assert.ok(adapter instanceof BitunixBrokerAdapter, `${venue}/${mode}: Bitunix-Adapter`);
        } else if (venue === "ALPACA") {
          assert.ok(adapter instanceof AlpacaBrokerAdapter, `${venue}/${mode}: Alpaca-Adapter`);
        } else {
          assert.ok(adapter instanceof StubBrokerAdapter, `${venue}/${mode}: Stub-Adapter`);
        }
      } catch (e) {
        assert.equal(expected.ok, false, `${venue}/${mode}: wirft unerwartet: ${e}`);
        if (expected.error === "LIVE_TRADING_GATE") {
          assert.ok(e instanceof LiveTradingGateError, `${venue}/${mode}: LGTE erwartet, got ${e}`);
          assert.equal((e as LiveTradingGateError).code, "LIVE_TRADING_GATE");
          assert.match((e as Error).message, new RegExp(venue));
        } else if (expected.error === "NOT_SUPPORTED_CAPABILITY") {
          assert.ok(
            e instanceof NotSupportedCapabilityError,
            `${venue}/${mode}: NSE erwartet, got ${e}`
          );
          assert.equal((e as NotSupportedCapabilityError).code, "NOT_SUPPORTED_CAPABILITY");
          assert.equal((e as NotSupportedCapabilityError).capability, expected.capability);
          assert.equal((e as NotSupportedCapabilityError).venue, venue);
          assert.match((e as Error).message, new RegExp(venue));
        }
      }
    }
  }
});

test("Kein stiller Fallback: abgewiesene Kombinationen werfen reproduzierbar", async () => {
  // DYDX kann paper nicht — der Aufruf darf nie still auf PAPER ausweichen.
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      () => getBroker("DYDX", "paper"),
      (e: unknown) => e instanceof NotSupportedCapabilityError
    );
  }
  // Und live wirft für ALLE Venues — selbst dort, wo capabilities.live
  // hypothetisch true sein könnte (Defense in Depth: das Gate kennt keine
  // Capability-Ausnahmen).
  for (const venue of BROKER_VENUE_IDS) {
    await assert.rejects(
      () => getBroker(venue, "live"),
      (e: unknown) => e instanceof LiveTradingGateError
    );
  }
});

test("Unbekannte Venues: UnknownVenueError (Input-Validierung zuerst)", async () => {
  const cases: unknown[] = [
    "COINBASE",
    "alpaca&x=1", // Injection-Versuch
    "PAPER; DROP TABLE positions",
    "",
    123,
    null,
  ];
  for (const c of cases) {
    await assert.rejects(
      () => getBroker(String(c) as never),
      (e: unknown) => e instanceof UnknownVenueError
    );
  }
  // Injection-Versuch: die Meldung bleibt sauber (gekürzt, keine SQL-Fragmente
  // über 40 Zeichen hinaus).
  await assert.rejects(
    () => getBroker("PAPER; DROP TABLE positions"),
    (e: unknown) => e instanceof UnknownVenueError && (e as Error).message.length < 200
  );
});

test("Capability-Gating-Table: Mode → Capability ist korrekt verdrahtet", () => {
  assert.deepEqual(REQUIRED_CAPABILITY_BY_MODE, {
    backtest: "paper",
    paper: "paper",
    testnet: "testnet",
    live: "live",
  });
  // Jedes Venue hat für jeden Modus eine definierte Gating-Entscheidung.
  for (const venue of BROKER_VENUE_IDS) {
    for (const mode of EXECUTION_MODES) {
      const required = REQUIRED_CAPABILITY_BY_MODE[mode];
      const has = VENUE_CAPABILITIES[venue][required];
      if (mode !== "live") {
        assert.equal(typeof has, "boolean", `${venue}/${mode}: Capability definiert`);
      }
    }
  }
});

test("Registry-Projektion: paperAvailable/liveAvailable = Adapter-Capabilities (SSoT)", () => {
  assert.deepEqual(
    Object.keys(BROKER_REGISTRY).sort(),
    [...BROKER_VENUE_IDS].sort(),
    "Registry deckt alle 7 Venues ab"
  );
  for (const venue of BROKER_VENUE_IDS) {
    const caps = VENUE_CAPABILITIES[venue];
    const entry = BROKER_REGISTRY[venue];
    // Projektion aus der Capability-Table:
    assert.equal(entry.paperAvailable, caps.paper, `${venue}: paperAvailable = caps.paper`);
    assert.equal(entry.liveAvailable, caps.live, `${venue}: liveAvailable = caps.live`);
    if (venue === "BITUNIX") {
      assert.equal(entry.liveAvailable, true, "BITUNIX: live-Capability ja, Ausführung nein");
      assert.equal(entry.paperAvailable, true);
    } else if (venue === "PAPER") {
      assert.equal(entry.liveAvailable, false);
      assert.equal(entry.paperAvailable, true);
    } else if (venue === "ALPACA") {
      assert.equal(entry.liveAvailable, true, "ALPACA: live-Capability ja, Ausführung nein");
      assert.equal(entry.paperAvailable, true);
    } else {
      assert.equal(entry.liveAvailable, false, `${venue}: liveAvailable=false (Stub)`);
      assert.equal(entry.paperAvailable, false);
    }
  }
});

test("Audit-Vollständigkeit: jeder Aufruf mit mode != 'paper' landet im Log", async () => {
  clearBrokerFactoryAuditForTests();
  let nonPaperCalls = 0;
  for (const venue of BROKER_VENUE_IDS) {
    for (const mode of EXECUTION_MODES) {
      if (mode === "paper") continue;
      nonPaperCalls++;
      try {
        await getBroker(venue, mode);
      } catch {
        /* erwartete Ablehnungen — zählen gleich im Ring */
      }
    }
  }
  assert.equal(nonPaperCalls, 21, "21 nicht-Paper-Aufrufe in der Matrix");

  const entries = readBrokerFactoryAudit(200);
  assert.equal(entries.length, 21, "genau 21 Audit-Einträge (neueste zuerst)");
  for (const e of entries) {
    assert.ok(BROKER_VENUE_IDS.includes(e.venue as BrokerVenueId), `venue: ${e.venue}`);
    assert.ok(EXECUTION_MODES.includes(e.mode), `mode: ${e.mode}`);
    assert.ok(e.outcome === "OK" || e.outcome === "DENIED", `outcome: ${e.outcome}`);
    assert.ok(Number.isFinite(Date.parse(e.at)), `timestamp gültig: ${e.at}`);
    assert.ok(e.at.endsWith("Z"), "UTC-Zeitstempel");
    if (e.outcome === "OK") {
      assert.equal(e.errorCode, null, "OK-Eintrag ohne Fehlercode");
      assert.equal(e.capability, null, "OK-Eintrag ohne Capability");
      assert.ok(
        e.venue === "PAPER" || e.venue === "BITUNIX" || e.venue === "ALPACA",
        `OK-Venue: ${e.venue}`
      );
      assert.ok(e.mode === "backtest" || e.mode === "testnet", `OK-Mode: ${e.mode}`);
    } else {
      assert.ok(e.errorCode, "DENIED-Eintrag mit Fehlercode");
    }
  }
  const okCount = entries.filter((e) => e.outcome === "OK").length;
  assert.equal(okCount, 4, "genau vier OK-Einträge (PAPER/backtest + BITUNIX/backtest + ALPACA/backtest + ALPACA/testnet)");
  const liveDenied = entries.filter((e) => e.errorCode === "LIVE_TRADING_GATE").length;
  assert.equal(liveDenied, 7, "alle 7 Live-Aufrufe auditiert");
  const capDenied = entries.filter((e) => e.errorCode === "NOT_SUPPORTED_CAPABILITY").length;
  assert.equal(capDenied, 10, "10 Capability-Ablehnungen auditiert (4 backtest-Stubs + 6 testnet-NSE)");
});

test("Audit: paper-Modus wird NICHT protokolliert (Regel: nur mode != 'paper')", async () => {
  clearBrokerFactoryAuditForTests();
  await getBroker("PAPER", "paper");
  assert.equal(readBrokerFactoryAudit().length, 0, "paper-Aufruf ohne Audit-Eintrag");
});

test("Audit: unbekannte Venues werden zusätzlich protokolliert (Vollständigkeit)", async () => {
  clearBrokerFactoryAuditForTests();
  await assert.rejects(() => getBroker("COINBASE", "paper"));
  const entries = readBrokerFactoryAudit();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].venue, "COINBASE");
  assert.equal(entries[0].outcome, "DENIED");
  assert.equal(entries[0].errorCode, "UNKNOWN_VENUE");
});

test("PAPER-Ledger: Singleton — backtest- und paper-Instanzen teilen den Ledger", async () => {
  const a = await getBroker("PAPER", "paper");
  const b = await getBroker("PAPER", "backtest");
  const a2 = await getBroker("PAPER", "paper");
  assert.equal(a, a2, "paper: gleicher Adapter (cache)");
  assert.ok(a instanceof PaperBrokerAdapter && b instanceof PaperBrokerAdapter);
  assert.equal(a.paperBroker, b.paperBroker, "dieselbe Ledger-Instanz");
  assert.equal(paperBrokerLedger(), (a as PaperBrokerAdapter).paperBroker);
  // Der Ledger kennt den Startkapital aus Env (Default 10000).
  assert.equal((a as PaperBrokerAdapter).paperBroker.startingEquity, 10000);
});

test("Audit-Ring: Überlauf wird gekappt (Max. 200 Einträge)", async () => {
  clearBrokerFactoryAuditForTests();
  for (let i = 0; i < 210; i++) {
    await getBroker("PAPER", "backtest");
  }
  const entries = readBrokerFactoryAudit(500);
  assert.equal(entries.length, 200, "Ring bleibt bei 200 Einträgen");
  // Die neuesten Einträge überleben, die ältesten fallen ab:
  assert.equal(entries[0].mode, "backtest");
});

test("Defense in Depth: Stub-Instanz im (unerrreichbaren) live-Kontext wirft LGTE", async () => {
  const { StubBrokerAdapter } = await import("../src/brokers/stubs");
  const liveStub = new StubBrokerAdapter("ALPACA", "live");
  await assert.rejects(
    () =>
      liveStub.placeOrder({
        symbol: "SPY",
        side: "LONG",
        qty: 10,
        riskNotional: 1000,
      }),
    (e: unknown) => e instanceof LiveTradingGateError
  );
});

test("normalizeVenue: Whitelist-Normalisierung (Großbuchstaben, Trim)", () => {
  assert.equal(normalizeVenue("paper"), "PAPER");
  assert.equal(normalizeVenue("  binance  "), "BINANCE");
  assert.equal(normalizeVenue("kraken"), "KRAKEN");
  assert.equal(normalizeVenue("IBKR"), "IBKR");
  assert.equal(normalizeVenue("dydx"), "DYDX");
  assert.equal(normalizeVenue("BITUNIX"), "BITUNIX");
  assert.equal(normalizeVenue("bitunix"), "BITUNIX");
  assert.equal(normalizeVenue("COINBASE"), null);
  assert.equal(normalizeVenue("PAPER; DROP"), null);
  assert.equal(normalizeVenue(""), null);
  assert.equal(normalizeVenue(null), null);
  assert.equal(normalizeVenue(42), null);
});
