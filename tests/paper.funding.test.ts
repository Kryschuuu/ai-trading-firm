/**
 * GAP-02 (v1.42.0) — Funding-Accrual im Paper-PnL + Kalibrierung der
 * Execution-Simulation.
 *
 * Deckt die Acceptance-Kriterien aus
 * docs/audits/2026-09-18-feature-gap/findings/GAP-02-execution-simulation.md
 * ab:
 *
 *   D1 Vorzeichen  — Long ZAHLT bei positiver Rate, Short ERHÄLT (exakt).
 *   D1 Perioden    — Accrual nur bei Periodenwechsel (Fake-Clock/injiziertes
 *                    nowMs; zweimal ticken → genau eine Accrual).
 *   D1 Audit+DB    — Persistenz + audit_log (Muster R6 „funding:SYMBOL:+x“),
 *                    Rollback des Ledgers bei Persistenzfehler (fail-closed).
 *   D2 Equity      — equity nach Accrual = vorher + fundingPaid-Summe;
 *                    Ausweis je Position (Ledger/Adapter) + Gesamt.
 *   D3 Bounds      — Flags außerhalb der Grenzen werden geklemmt (Warnung),
 *                    Defaults = heutige hartcodierte Werte (kein Bruch).
 *   D3 Neutral     — Rate-Default 0: kein Event, keine Buchung, bestehende
 *                    Broker-Tests bleiben unverändert grün (Suite).
 *   D4 Determinismus — identische Quote-Folge → identische Fills
 *                    (SHA-256-Vergleich), Engine ohne Date.now()/Random.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PaperBroker } from "../src/lib/broker";
import { resetRuntimeLimits } from "../src/lib/riskGuard";
import {
  FUNDING_DEFAULTS,
  FUNDING_ENV,
  FundingAccrualEngine,
  computeFunding,
  loadFundingConfig,
  runFundingAccrual,
  type FundingApplyRow,
} from "../src/lib/funding";
import {
  resetAuditDurabilityForTests,
  setAuditTransportForTests,
  type AuditRow,
} from "../src/lib/auditSink";
import {
  CALIBRATION_ENV,
  calibrateSimulatorConfig,
  loadSimulatorConfig,
} from "../src/lib/marketdata/config";
import { createPaperExecution } from "../src/lib/marketdata/production";
import type { MarketDataManager } from "../src/lib/marketdata/manager";
import { instrument } from "./fixtures/scannerFixtures";

/** 2026-09-18T00:00:00Z — saubere UTC-Basis; 8h-Marken bei 00/08/16 UTC. */
const T0 = Date.UTC(2026, 8, 18);
const H = 3_600_000;

/** Konsole-Warnungen einfangen (Bounds-Clamp muss laut sein). */
function captureWarn(): { messages: string[]; restore(): void } {
  const original = console.warn;
  const messages: string[] = [];
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((a) => String(a)).join(" "));
  };
  return { messages, restore: () => (console.warn = original) };
}

/** Perpetual-Testzeile (Monitor-Sicht: DB-Zeile + frischer Kurs). */
function perpRow(overrides: Partial<FundingApplyRow> = {}): FundingApplyRow {
  return {
    id: "pos-1",
    missionId: null,
    symbol: "BTC/USD",
    side: "LONG",
    qty: 2,
    price: 5000,
    isPerpetual: true,
    ...overrides,
  };
}

beforeEach(() => {
  resetRuntimeLimits();
});

afterEach(() => {
  // Audit-Senke zurücksetzen (Transport-Override aus dem R6-Test entfernen).
  resetAuditDurabilityForTests();
});

// ── D1: Vorzeichenkonvention (Formel, exakt) ────────────────────────────────

test("GAP-02 D1: Long ZAHLT bei positiver Rate, Short ERHÄLT — Vorzeichen exakt", () => {
  // rate 0.0001 = 0,01 %/8h auf |notional| 10 000 ⇒ 1.00 je Periode.
  const long = computeFunding({ side: "LONG", qty: 2, price: 5000 }, { intervalHours: 8 }, 0.0001);
  assert.ok(long, "gültige Eingabe muss berechenbar sein");
  assert.equal(long.notional, 10_000);
  assert.ok(Math.abs(long.funding - (-1)) < 1e-12, `Long zahlt ⇒ Kontosicht −1, war ${long.funding}`);

  const short = computeFunding({ side: "SHORT", qty: 2, price: 5000 }, { intervalHours: 8 }, 0.0001);
  assert.ok(short, "gültige Eingabe muss berechenbar sein");
  assert.ok(Math.abs(short.funding - 1) < 1e-12, `Short erhält ⇒ Kontosicht +1, war ${short.funding}`);

  // Negative Rate dreht die Richtung: Long erhält, Short zahlt.
  const longNeg = computeFunding({ side: "LONG", qty: 2, price: 5000 }, { intervalHours: 8 }, -0.0001);
  assert.ok(longNeg, "gültige Eingabe muss berechenbar sein");
  assert.ok(Math.abs(longNeg.funding - 1) < 1e-12);

  // Intervall-Skalierung: 4h-Takt ⇒ halbe Rate je Accrual (gleiche Jahreslast).
  const half = computeFunding({ side: "LONG", qty: 2, price: 5000 }, { intervalHours: 4 }, 0.0001);
  assert.ok(half, "gültige Eingabe muss berechenbar sein");
  assert.ok(Math.abs(half.funding - (-0.5)) < 1e-12);

  // Kaputte Eingaben ⇒ null — keine erfundenen Kosten (fail-safe).
  assert.equal(computeFunding({ side: "LONG", qty: NaN, price: 5000 }, { intervalHours: 8 }, 0.0001), null);
  assert.equal(computeFunding({ side: "LONG", qty: 2, price: 0 }, { intervalHours: 8 }, 0.0001), null);
  assert.equal(computeFunding({ side: "LONG", qty: 2, price: 5000 }, { intervalHours: 8 }, NaN), null);
});

// ── D1: Accrual nur bei Periodenwechsel (injizierbare Clock) ────────────────

test("GAP-02 D1: Accrual NUR bei Periodenwechsel — zweimal ticken, genau eine Accrual", () => {
  const engine = new FundingAccrualEngine({ intervalHours: 8, ratePctPer8h: 0.01 });
  const rows = [perpRow()];

  assert.deepEqual(engine.dueAccruals(rows, T0), [], "erste Sichtung bucht nichts nach");
  assert.deepEqual(engine.dueAccruals(rows, T0 + 7 * H), [], "vor der 8h-Marke (07:00 UTC): kein Accrual");

  const due = engine.dueAccruals(rows, T0 + 8 * H + 60_000); // 08:01 UTC — Marke überstanden
  assert.equal(due.length, 1, "genau eine Accrual nach der Marke");
  assert.equal(due[0].symbol, "BTC/USD");
  assert.equal(due[0].periods, 1);
  assert.ok(Math.abs(due[0].funding - (-1)) < 1e-9, "0,01 %/8h auf 10 000 ⇒ −1");

  assert.deepEqual(engine.dueAccruals(rows, T0 + 8 * H + 120_000), [], "zweiter Tick ohne weiteren Wechsel: kein Accrual");
});

test("GAP-02 D1: Standby über zwei Marken ⇒ ein Accrual mit periods=2 (doppelte Last)", () => {
  const engine = new FundingAccrualEngine({ intervalHours: 8, ratePctPer8h: 0.01 });
  const rows = [perpRow()];
  engine.dueAccruals(rows, T0); // Sichtung
  const due = engine.dueAccruals(rows, T0 + 16 * H); // 16h später = 2 Marken
  assert.equal(due.length, 1);
  assert.equal(due[0].periods, 2);
  assert.ok(Math.abs(due[0].funding - (-2)) < 1e-9, "zwei Perioden ⇒ −2");
});

test("GAP-02 D1: rückwärts laufende Clock löst nichts aus (monoton)", () => {
  const engine = new FundingAccrualEngine({ intervalHours: 8, ratePctPer8h: 0.01 });
  const rows = [perpRow()];
  engine.dueAccruals(rows, T0 + 8 * H); // Marke 1 konsumiert
  assert.deepEqual(engine.dueAccruals(rows, T0 + 7 * H), [], "Zeitsprung zurück: kein (Doppel-)Accrual");
  assert.deepEqual(engine.dueAccruals(rows, T0 + 8 * H), [], "gleiche Marke erneut: kein Doppel-Accrual");
});

// ── D1: Buchung Ledger → DB → Audit (runFundingAccrual, Fake-Sinks) ─────────

test("GAP-02 D1: runFundingAccrual bucht genau einmal — Ledger, Persistenz, Audit (Muster R6)", async () => {
  const broker = new PaperBroker(10_000);
  broker.hydrate(
    [{ symbol: "BTC/USD", side: "LONG", qty: 2, entryPrice: 5000, fundingPaid: -0.5 }],
    { cashHint: 9000 }
  );
  const engine = new FundingAccrualEngine({ intervalHours: 8, ratePctPer8h: 0.01 });
  const rows = [perpRow()];
  const persisted: unknown[] = [];

  // Echter Audit-Standardpfad (kein injiziertes audit): writeAuditRecord →
  // Transport-Override fängt die Zeile ab, die sonst in audit_log landen würde.
  const auditRows: AuditRow[] = [];
  setAuditTransportForTests(async (row) => {
    auditRows.push(row);
  });
  const fundingAuditRows = (): AuditRow[] => auditRows.filter((r) => r.event === "FUNDING_ACCRUAL");

  const sinks = {
    persist: async (a: unknown): Promise<void> => {
      persisted.push(a);
    },
  };

  const first = await runFundingAccrual({ broker, rows, nowMs: T0, engine, ...sinks });
  assert.equal(first.length, 0, "erste Sichtung: nichts gebucht");
  assert.equal(persisted.length, 0);
  assert.equal(fundingAuditRows().length, 0);

  const second = await runFundingAccrual({ broker, rows, nowMs: T0 + 8 * H, engine, ...sinks });
  assert.equal(second.length, 1, "genau eine Buchung nach der Marke");
  assert.ok(Math.abs(second[0].funding - (-1)) < 1e-9);
  assert.ok(Math.abs(second[0].fundingPaid - (-1.5)) < 1e-9, "Kumulativ: −0.5 (Alt) − 1 (neu)");
  assert.equal(persisted.length, 1, "DB-Zeile genau einmal fortgeschrieben");
  assert.equal(fundingAuditRows().length, 1, "Accrual-Ereignis revisionssicher ins audit_log");
  assert.equal(fundingAuditRows()[0].level, "INFO");
  const detail = fundingAuditRows()[0].detail as { message: string; funding: number; fundingPaid: number };
  assert.match(detail.message, /^funding:BTC\/USD:-1\.0000$/, "Audit-Muster R6 „funding:SYMBOL:±x“");
  assert.ok(Math.abs(detail.funding - (-1)) < 1e-9);

  // Dritter Tick ohne Marke: wieder Ruhe.
  const third = await runFundingAccrual({ broker, rows, nowMs: T0 + 8 * H + 5 * 60_000, engine, ...sinks });
  assert.equal(third.length, 0);
  assert.equal(fundingAuditRows().length, 1, "kein zweites Audit für dieselbe Marke");
});

test("GAP-02 D1: schlägt die Persistenz fehl, wird die Ledger-Buchung zurückgerollt (fail-closed)", async () => {
  const broker = new PaperBroker(10_000);
  broker.hydrate([{ symbol: "BTC/USD", side: "LONG", qty: 2, entryPrice: 5000 }], { cashHint: 9000 });
  const engine = new FundingAccrualEngine({ intervalHours: 8, ratePctPer8h: 0.01 });
  const rows = [perpRow()];
  const noop = { persist: async () => {}, audit: async () => {} };

  await runFundingAccrual({ broker, rows, nowMs: T0, engine, ...noop });
  const equityBefore = broker.accountEquity;

  await assert.rejects(
    runFundingAccrual({
      broker,
      rows,
      nowMs: T0 + 8 * H,
      engine,
      persist: async () => {
        throw new Error("db down");
      },
      audit: async () => {},
    }),
    /db down/
  );
  assert.ok(Math.abs(broker.accountEquity - equityBefore) < 1e-9, "Ledger nach Rollback auf Vorher-Stand");
  assert.equal(broker.totalFundingPaid, 0, "kumulatives Funding zurückgesetzt");
});

// ── D2: Equity & Ausweis ────────────────────────────────────────────────────

test("GAP-02 D2: equity nach Accrual = vorher + fundingPaid-Summe", async () => {
  const broker = new PaperBroker(10_000);
  broker.hydrate(
    [
      { symbol: "BTC/USD", side: "LONG", qty: 2, entryPrice: 5000 },
      { symbol: "ETH/USD", side: "SHORT", qty: 1, entryPrice: 8000 },
    ],
    { cashHint: 9000 }
  );
  const equityBefore = broker.accountEquity;

  const engine = new FundingAccrualEngine({ intervalHours: 8, ratePctPer8h: 0.01 });
  const rows = [
    perpRow(),
    perpRow({ id: "pos-2", symbol: "ETH/USD", side: "SHORT", qty: 1, price: 8000 }),
  ];
  const noop = { persist: async () => {}, audit: async () => {} };

  await runFundingAccrual({ broker, rows, nowMs: T0, engine, ...noop }); // Sichtung
  const events = await runFundingAccrual({ broker, rows, nowMs: T0 + 8 * H, engine, ...noop });

  // LONG zahlt −1 (Notional 10 000), SHORT erhält +0.8 (Notional 8 000).
  assert.equal(events.length, 2);
  const sum = events.reduce((acc, e) => acc + e.funding, 0);
  assert.ok(Math.abs(sum - (-0.2)) < 1e-9, `Summe der Accruals erwartet −0.2, war ${sum}`);
  assert.ok(
    Math.abs(broker.accountEquity - (equityBefore + sum)) < 1e-6,
    "equity nach Accrual = vorher + fundingPaid-Summe"
  );
  assert.ok(Math.abs(broker.totalFundingPaid - sum) < 1e-9, "Gesamtfunding = fundingPaid-Summe");
});

test("GAP-02 D2: accrueFunding bucht Cash + Kumulativ; Ausweis je Position; hydrate erhält Funding", () => {
  const broker = new PaperBroker(10_000);
  broker.hydrate(
    [{ symbol: "BTC/USD", side: "LONG", qty: 2, entryPrice: 5000, fundingPaid: -2 }],
    { cashHint: 9000 }
  );
  const cashBefore = broker.freeCash;

  const booked = broker.accrueFunding("BTC/USD", -0.5);
  assert.deepEqual(booked, { symbol: "BTC/USD", funding: -0.5, fundingPaid: -2.5 });
  assert.ok(Math.abs(broker.freeCash - (cashBefore - 0.5)) < 1e-9, "Cash sinkt beim Zahlen");
  assert.equal(broker.getPosition("BTC/USD")?.fundingPaid, -2.5, "getPosition weist fundingPaid aus");
  assert.equal(broker.listPositions()[0].fundingPaid, -2.5, "listPositions weist fundingPaid aus");
  assert.ok(Math.abs(broker.totalFundingPaid - (-2.5)) < 1e-9);

  // Erhalten erhöht Cash.
  broker.accrueFunding("BTC/USD", 0.25);
  assert.ok(Math.abs(broker.freeCash - (cashBefore - 0.25)) < 1e-9);

  // Fail-closed: unbekanntes Symbol / NaN ⇒ null, nichts gebucht.
  assert.equal(broker.accrueFunding("NOPE", -1), null);
  assert.equal(broker.accrueFunding("BTC/USD", NaN), null);
  assert.equal(broker.accrueFunding("BTC/USD", Infinity), null);
  assert.ok(Math.abs(broker.freeCash - (cashBefore - 0.25)) < 1e-9);

  // Legacy-Restore ohne cashHint: Funding fließt in den Cash-Stand ein.
  const b2 = new PaperBroker(10_000);
  b2.hydrate([{ symbol: "BTC/USD", side: "LONG", qty: 2, entryPrice: 5000, fundingPaid: -2 }]);
  assert.ok(Math.abs(b2.freeCash - (10_000 - 10_000 - 2)) < 1e-9, "startEquity − Einstieg + fundingPaid");

  // Kaputte fundingPaid-Werte ⇒ 0 (kein NaN ins Ledger).
  const b3 = new PaperBroker(10_000);
  b3.hydrate([{ symbol: "BTC/USD", side: "LONG", qty: 2, entryPrice: 5000, fundingPaid: NaN }]);
  assert.equal(b3.getPosition("BTC/USD")?.fundingPaid, 0);
  assert.equal(b3.freeCash, 0, "NaN-Funding neutralisieren, nicht übernehmen");
});

// ── D3: Bounds + Defaults (Funding) ─────────────────────────────────────────

test("GAP-02 D3: Funding-Flags außerhalb der Bounds werden geklemmt — mit Warnung", () => {
  const cap = captureWarn();
  try {
    const cfg = loadFundingConfig({
      [FUNDING_ENV.INTERVAL_HOURS]: "48", // > 24
      [FUNDING_ENV.RATE_PCT_PER_8H]: "5", // > 1
    });
    assert.equal(cfg.intervalHours, 24, "Intervall auf 24h geklemmt");
    assert.equal(cfg.ratePctPer8h, 1, "Rate auf +1 %/8h geklemmt");
    assert.equal(loadFundingConfig({ [FUNDING_ENV.INTERVAL_HOURS]: "0" }).intervalHours, 1, "Intervall auf 1h geklemmt");
    assert.equal(loadFundingConfig({ [FUNDING_ENV.RATE_PCT_PER_8H]: "-9" }).ratePctPer8h, -1, "Rate auf −1 %/8h geklemmt");

    // Ungültige Werte ⇒ sicherer Default (neutral).
    const invalid = loadFundingConfig({ [FUNDING_ENV.INTERVAL_HOURS]: "abc", [FUNDING_ENV.RATE_PCT_PER_8H]: "abc" });
    assert.equal(invalid.intervalHours, FUNDING_DEFAULTS.intervalHours);
    assert.equal(invalid.ratePctPer8h, FUNDING_DEFAULTS.ratePctPer8h);

    // Fail-laut: jede Korrektur erzeugt eine Warnung mit Flag-Name.
    assert.ok(cap.messages.some((m) => m.includes("PAPER_FUNDING_INTERVAL_HOURS") && m.includes("24")), `Warnung Intervall fehlt: ${JSON.stringify(cap.messages)}`);
    assert.ok(cap.messages.some((m) => m.includes("PAPER_FUNDING_RATE_PCT_PER_8H") && m.includes("1")), `Warnung Rate fehlt: ${JSON.stringify(cap.messages)}`);
    assert.ok(cap.messages.some((m) => m.includes("ist keine Zahl")), "ungültiger Wert muss warnen");
  } finally {
    cap.restore();
  }
});

// ── D3: Kalibrierung der Execution-Simulation ───────────────────────────────

test("GAP-02 D3: Kalibrierungs-Flags — ohne Flags unverändert, mit Flags Clamp + Warnung", () => {
  const base = loadSimulatorConfig({}); // Defaults = heutige hartcodierte Werte
  assert.equal(base.makerFeeFallback, 0.0004);
  assert.equal(base.takerFeeFallback, 0.001);
  assert.equal(base.slippageBpsBase, 1);
  assert.equal(base.syntheticSpreadBps, 2);

  // Kein Flag gesetzt ⇒ identisch mit Basis (kein Verhaltensbruch) — und als
  // SELBE Referenz: Live-Mutationen an der Manager-Konfiguration (z. B.
  // partialFillEnabled nach der Verdrahtung, siehe
  // tests/marketdata.broker.integration.test.ts) bleiben sichtbar.
  const untouched = calibrateSimulatorConfig(base, {});
  assert.deepEqual(untouched, base);
  assert.equal(untouched, base, "ohne Kalibrierungs-Flags muss base als Referenz durchgereicht werden");

  // Legacy-PAPER_SIM_* bleibt wirksam (Basis kommt aus der Manager-Config).
  const withLegacy = loadSimulatorConfig({ PAPER_SIM_TAKER_FEE: "0.002" });
  assert.equal(calibrateSimulatorConfig(withLegacy, {}).takerFeeFallback, 0.002);

  const cap = captureWarn();
  try {
    const over = calibrateSimulatorConfig(base, {
      [CALIBRATION_ENV.PAPER_MAKER_FEE_PCT]: "0.04", // 0,04 % ⇒ 0.0004
      [CALIBRATION_ENV.PAPER_TAKER_FEE_PCT]: "999", // 999 % ⇒ Clamp 10 %
      [CALIBRATION_ENV.PAPER_SLIPPAGE_BPS]: "-5", // ⇒ Clamp 0
      [CALIBRATION_ENV.PAPER_SPREAD_FALLBACK_BPS]: "5",
    });
    assert.equal(over.makerFeeFallback, 0.0004, "Prozent ⇒ Dezimalanteil");
    assert.equal(over.takerFeeFallback, 0.1, "999 % auf 10 % geklemmt");
    assert.equal(over.slippageBpsBase, 0, "−5 bp auf 0 geklemmt");
    assert.equal(over.syntheticSpreadBps, 5);
    assert.ok(cap.messages.some((m) => m.includes("PAPER_TAKER_FEE_PCT")), `Clamp-Warnung Taker fehlt: ${JSON.stringify(cap.messages)}`);
    assert.ok(cap.messages.some((m) => m.includes("PAPER_SLIPPAGE_BPS")), `Clamp-Warnung Slippage fehlt: ${JSON.stringify(cap.messages)}`);

    // Ungültiger Wert ⇒ Kalibrierung ignoriert, Basis bleibt (fail-laut).
    const invalid = calibrateSimulatorConfig(base, { [CALIBRATION_ENV.PAPER_SLIPPAGE_BPS]: "abc" });
    assert.equal(invalid.slippageBpsBase, base.slippageBpsBase);
    assert.ok(cap.messages.some((m) => m.includes("ist keine Zahl")));
  } finally {
    cap.restore();
  }
});

// ── D1: Default 0 = neutral (bestehende Tests/Installationen unverändert) ───

test("GAP-02 D1: Default-Rate 0 = neutral — kein Event, keine Buchung, Ledger unverändert", async () => {
  const cfg = loadFundingConfig({});
  assert.equal(cfg.intervalHours, 8, "Default-Intervall 8h (UTC-Marke)");
  assert.equal(cfg.ratePctPer8h, 0, "Default-Rate 0 = neutral");

  const broker = new PaperBroker(10_000);
  broker.hydrate([{ symbol: "BTC/USD", side: "LONG", qty: 2, entryPrice: 5000 }], { cashHint: 9000 });
  const equityBefore = broker.accountEquity;
  const engine = new FundingAccrualEngine(cfg);
  const rows = [perpRow()];
  let persistCalls = 0;
  let auditCalls = 0;
  const sinks = {
    persist: async () => {
      persistCalls++;
    },
    audit: async () => {
      auditCalls++;
    },
  };

  await runFundingAccrual({ broker, rows, nowMs: T0, engine, ...sinks });
  const events = await runFundingAccrual({ broker, rows, nowMs: T0 + 8 * H, engine, ...sinks });
  assert.equal(events.length, 0, "Rate 0 ⇒ kein Accrual");
  assert.equal(persistCalls, 0, "keine DB-Schreiboperation");
  assert.equal(auditCalls, 0, "kein Audit-Eintrag");
  assert.equal(broker.accountEquity, equityBefore, "Equity unverändert");
  assert.equal(broker.totalFundingPaid, 0);
});

test("GAP-02 D1: nur Perpetuals zahlen — Spot und unbekannte Instrumente bleiben frei", () => {
  const engine = new FundingAccrualEngine({ intervalHours: 8, ratePctPer8h: 0.01 });
  const spot = [perpRow({ symbol: "AAPL", isPerpetual: false })];
  engine.dueAccruals(spot, T0); // Sichtung
  assert.deepEqual(engine.dueAccruals(spot, T0 + 8 * H), [], "Spot zahlt kein Funding");

  const unknown = new FundingAccrualEngine({ intervalHours: 8, ratePctPer8h: 0.01 });
  unknown.dueAccruals([perpRow({ symbol: "XYZ", isPerpetual: undefined })], T0);
  assert.deepEqual(
    unknown.dueAccruals([perpRow({ symbol: "XYZ", isPerpetual: undefined })], T0 + 8 * H),
    [],
    "isPerpetual unbekannt ⇒ kein Funding (fail-safe gegen erfundene Lasten)"
  );
});

test("GAP-02 D1: Rate-Quelle gestuft — Provider vor statischem Default", () => {
  const engine = new FundingAccrualEngine(
    { intervalHours: 8, ratePctPer8h: 0.01 },
    { rateProvider: { getFundingRate: (symbol) => (symbol === "BTC/USD" ? 0.0002 : null) } }
  );
  const rows = [perpRow(), perpRow({ id: "p2", symbol: "ETH/USD", side: "SHORT", qty: 1, price: 8000 })];
  engine.dueAccruals(rows, T0); // Sichtung
  const due = engine.dueAccruals(rows, T0 + 8 * H);
  assert.equal(due.length, 2);
  const btc = due.find((d) => d.symbol === "BTC/USD");
  const eth = due.find((d) => d.symbol === "ETH/USD");
  assert.ok(btc && Math.abs(btc.ratePer8h - 0.0002) < 1e-12, "Provider-Rate gewinnt");
  assert.ok(btc && Math.abs(btc.funding - (-2)) < 1e-9, "0.02 %/8h auf 10 000 ⇒ −2");
  assert.ok(eth && Math.abs(eth.ratePer8h - 0.0001) < 1e-12, "null vom Provider ⇒ statischer Default (0,01 %)");
  assert.ok(eth && Math.abs(eth.funding - 0.8) < 1e-9, "SHORT erhält");
});

// ── D4: Determinismus ───────────────────────────────────────────────────────

test("GAP-02 D4: identische Quote-Folge ⇒ identische Fills (SHA-256-Vergleich)", () => {
  const perp = instrument({ venue: "PAPER", symbol: "BTCUSDT", marketType: "perpetual", makerFee: 0.0004, takerFee: 0.001 });
  const quote = { bid: 67450, ask: 67453, last: 67451, spread: 3 / 67451, volume24h: 1_000_000_000 };
  const manager = {
    config: {
      simulator: {
        ...loadSimulatorConfig({}),
        partialFillEnabled: true, // auch die RNG-Pfade (Partial Fills) prüfen
        partialFillMaxFraction: 0.8,
        slippageJitterBps: 2,
        seed: 7,
      },
    },
    getSnapshotSync: () => quote,
    resolveInstrument: () => perp,
  } as unknown as MarketDataManager;

  const orders = [
    { symbol: "BTCUSDT", side: "LONG" as const, qty: 0.01, riskNotional: 700, stopLoss: 60000, takeProfit: 70000 },
    { symbol: "BTCUSDT", side: "SHORT" as const, qty: 0.5, riskNotional: 34_000, stopLoss: 70000, takeProfit: 60000 },
    { symbol: "BTCUSDT", side: "LONG" as const, qty: 200, riskNotional: 13_500_000, stopLoss: 60000, takeProfit: 70000 },
  ];

  const run = (): string => {
    const exec = createPaperExecution(manager); // frische Instanz, gleicher Seed
    const fills = orders.map((o) => exec.execute(o, exec.quoteProvider("BTCUSDT")!));
    return createHash("sha256").update(JSON.stringify(fills)).digest("hex");
  };
  const a = run();
  const b = run();
  assert.equal(a, b, "gleiche Quote-Folge + Seed ⇒ bit-identische Fills");
  assert.notEqual(a, "", "Hash darf nicht leer sein");
});

test("GAP-02 D4: Engine deterministisch — gleiche Inputs ⇒ gleiche Accruals, keine Wanduhr", () => {
  const rows = [perpRow()];
  const mk = () => {
    const e = new FundingAccrualEngine({ intervalHours: 8, ratePctPer8h: 0.01 });
    e.dueAccruals(rows, T0); // Sichtung
    return e.dueAccruals(rows, T0 + 8 * H);
  };
  const a = mk();
  const b = mk();
  assert.deepEqual(a, b, "zwei frische Engines, gleiche (Zeit, Zeilen) ⇒ identische Accruals");
  // und das Ergebnis ist das exakt erwartete Objekt (Vorzeichen/Skalierung fix).
  assert.deepEqual(a, [
    {
      symbol: "BTC/USD",
      side: "LONG",
      ratePer8h: 0.0001,
      ratePerInterval: 0.0001,
      periods: 1,
      notional: 10_000,
      funding: -1,
    },
  ]);
});
