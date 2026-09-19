/**
 * Tests für Reconciliation Broker ↔ DB + Idempotente Order-IDs (GAP-09, v1.50.0).
 *
 * Prüfpunkte:
 *   1. Klassifikation: je Differenztyp ein Fall (PRICE_DRIFT, QTY_MISMATCH,
 *      PHANTOM_POSITION, MISSING_POSITION, BALANCE_MISMATCH), inkl.
 *      Toleranz-Grenzfälle (genau RECON_PRICE_DRIFT_PCT → PRICE_DRIFT-only).
 *   2. Pause-Pfad: RECON_PAUSE_ON_MISMATCH=false → nur Report/Audit;
 *      true → Kill-Switch ENGAGE mit Grund „recon:<klasse>“; Disarm weiterhin nur manuell.
 *   3. Idempotenz: Timeout nach Submit (Mock), Retry mit gleicher clientOrderId →
 *      genau eine Order; zweiter unabhängiger Intent → zweite Order.
 *   4. Paper-Invarianz: gesundes Ledger → keine Befunde; manipuliertes Fixture
 *      (negatives Cash, Notional > Equity) → INVARIANT_VIOLATION + Audit.
 *   5. Scheduler-Intervall mit Fake-Clock; CLI-Run schreibt Report-Datei.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

import {
  classifyDifferences,
  buildClientOrderId,
  submitWithIntent,
  runReconciliation,
  formatReconReason,
  loadReconciliationConfig,
  type ReconciliationConfig,
  type DbPositionSnapshot,
  type DbAccountSnapshot,
  type DbOrderIntent,
  type ReconciliationDbStore,
} from "../src/brokers/reconciliation";
import type {
  BrokerAccount,
  BrokerAdapter,
  BrokerHealth,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPosition,
  ExecutionMode,
} from "../src/contracts/broker";
import { killSwitch } from "../src/lib/riskGuard";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import {
  issueDisarmNonce,
  consumeDisarmNonce,
  resetDisarmNoncesForTests,
} from "../src/lib/disarmChallenge";
import type { AuditRecord } from "../src/lib/auditSink";
import type { Alert } from "../src/lib/alerts";

// ─────────────────────────────────────────────────────────────────────────────
// Test-Fixtures & Mock-Helfer
// ─────────────────────────────────────────────────────────────────────────────

function defaultConfig(): ReconciliationConfig {
  return {
    priceDriftPct: 1.0,
    intervalMinutes: 60,
    pauseOnMismatch: false,
  };
}

function mockAccount(overrides: Partial<BrokerAccount> = {}): BrokerAccount {
  return {
    equity: 10000,
    cash: 10000,
    walletBalance: 10000,
    availableCash: 10000,
    usedMargin: 0,
    maintenanceMargin: 0,
    unrealizedPnl: 0,
    openPositions: 0,
    startingEquity: 10000,
    drawdownPct: 0,
    ...overrides,
  };
}

function mockPosition(overrides: Partial<BrokerPosition> = {}): BrokerPosition {
  return {
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 0.1,
    entryPrice: 60000,
    lastPrice: 60000,
    unrealizedPnl: 0,
    stopLoss: 58000,
    takeProfit: 65000,
    ...overrides,
  };
}

function mockDbPosition(overrides: Partial<DbPositionSnapshot> = {}): DbPositionSnapshot {
  return {
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 0.1,
    entryPrice: 60000,
    currentPrice: 60000,
    status: "OPEN",
    ...overrides,
  };
}

class MockAdapter implements BrokerAdapter {
  readonly id = "PAPER" as const;
  readonly mode: ExecutionMode = "paper";
  readonly capabilities = {
    discovery: true,
    marketData: true,
    trading: true,
    paper: true,
    testnet: false,
    live: false,
    instrumentTypes: { spot: true, perpetual: true, future: false, option: false },
    stopAtVenue: false,
  };

  positions: BrokerPosition[] = [];
  account: BrokerAccount = mockAccount();
  placedOrders: BrokerOrderRequest[] = [];

  constructor(positions: BrokerPosition[] = [], account?: Partial<BrokerAccount>) {
    this.positions = positions;
    if (account) this.account = mockAccount(account);
  }

  async healthCheck(): Promise<BrokerHealth> {
    return { status: "online", latencyMs: 1, details: {} };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return this.positions;
  }

  async getAccount(): Promise<BrokerAccount> {
    return this.account;
  }

  async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    this.placedOrders.push(req);
    return {
      orderId: `mock-order-${this.placedOrders.length}`,
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      fillPrice: req.limitPrice ?? 60000,
      status: "FILLED",
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
    };
  }
}

class MockDbStore implements ReconciliationDbStore {
  positions: DbPositionSnapshot[] = [];
  latestSnapshot: { equity: number; cash: number; openPositions: number } | null = null;
  intents: DbOrderIntent[] = [];
  killSwitchRecords: { reason: string; triggeredBy: string; armed: boolean }[] = [];

  constructor(opts: {
    positions?: DbPositionSnapshot[];
    snapshot?: { equity: number; cash: number; openPositions: number };
    intents?: DbOrderIntent[];
  } = {}) {
    this.positions = opts.positions ?? [];
    this.latestSnapshot = opts.snapshot ?? null;
    this.intents = opts.intents ?? [];
  }

  async getOpenPositions(): Promise<DbPositionSnapshot[]> {
    return this.positions;
  }

  async getLatestEquitySnapshot() {
    return this.latestSnapshot;
  }

  async getOrderIntents(opts?: { status?: string; symbol?: string }): Promise<DbOrderIntent[]> {
    return this.intents.filter((i) => {
      if (opts?.status && i.status !== opts.status) return false;
      if (opts?.symbol && i.symbol.toUpperCase() !== opts.symbol.toUpperCase()) return false;
      return true;
    });
  }

  async recordKillSwitch(row: { reason: string; triggeredBy: string; armed: boolean }): Promise<void> {
    this.killSwitchRecords.push(row);
  }

  async updateOrderIntent(id: string, update: { status: string; reason?: string }): Promise<void> {
    const found = this.intents.find((i) => i.id === id);
    if (found) {
      found.status = update.status;
      if (update.reason !== undefined) found.reason = update.reason;
    }
  }
}

beforeEach(() => {
  __resetAllSingletonsForTests();
  resetDisarmNoncesForTests();
  killSwitch.disarm();
});

afterEach(() => {
  __resetAllSingletonsForTests();
  resetDisarmNoncesForTests();
  killSwitch.disarm();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Differenz-Klassifikation (reine Funktion)
// ─────────────────────────────────────────────────────────────────────────────

test("Klassifikation: sauberer Abgleich ohne Differenzen", () => {
  const bPos = [mockPosition({ symbol: "BTCUSDT", qty: 0.1, entryPrice: 60000 })];
  const dPos = [mockDbPosition({ symbol: "BTCUSDT", qty: 0.1, entryPrice: 60000 })];
  const diffs = classifyDifferences({
    brokerPositions: bPos,
    brokerAccount: mockAccount({ cash: 4000, equity: 10000 }),
    dbPositions: dPos,
    dbAccount: { cash: 4000, equity: 10000 },
    config: defaultConfig(),
    isPaper: false,
  });

  assert.equal(diffs.length, 0, "Keine Diskrepanzen erwartet");
});

test("Klassifikation: PRICE_DRIFT innerhalb Toleranz (0.5 % bei 1.0 % Limit) → tolerierbar, critical=false", () => {
  // DB entry: 60000, Broker entry: 60300 → Drift = 300 / 60000 = 0.5 %
  const bPos = [mockPosition({ symbol: "BTCUSDT", qty: 0.1, entryPrice: 60300 })];
  const dPos = [mockDbPosition({ symbol: "BTCUSDT", qty: 0.1, entryPrice: 60000 })];
  const diffs = classifyDifferences({
    brokerPositions: bPos,
    brokerAccount: mockAccount({ cash: 3970, equity: 10000 }),
    dbPositions: dPos,
    dbAccount: { cash: 3970, equity: 10000 },
    config: defaultConfig(),
    isPaper: false,
  });

  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].type, "PRICE_DRIFT");
  assert.equal(diffs[0].critical, false, "Innerhalb Toleranz darf NICHT als kritisch eingestuft werden");
  assert.ok(diffs[0].pct! <= 1.0);
});

test("Klassifikation: Toleranz-Grenzfall genau RECON_PRICE_DRIFT_PCT (1.00 %) → PRICE_DRIFT-only (critical=false)", () => {
  // DB entry: 60000, Broker entry: 60600 → Drift = 600 / 60000 = 1.00 %
  const bPos = [mockPosition({ symbol: "BTCUSDT", qty: 0.1, entryPrice: 60600 })];
  const dPos = [mockDbPosition({ symbol: "BTCUSDT", qty: 0.1, entryPrice: 60000 })];
  const diffs = classifyDifferences({
    brokerPositions: bPos,
    brokerAccount: mockAccount({ cash: 3940, equity: 10000 }),
    dbPositions: dPos,
    dbAccount: { cash: 3940, equity: 10000 },
    config: defaultConfig(), // priceDriftPct = 1.0
    isPaper: false,
  });

  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].type, "PRICE_DRIFT");
  assert.equal(diffs[0].critical, false, "Genau auf der Grenze gilt als tolerierbar (PRICE_DRIFT-only)");
});

test("Klassifikation: PRICE_DRIFT überschreitet Toleranz (2.0 % bei 1.0 % Limit) → critical=true", () => {
  // DB entry: 60000, Broker entry: 61200 → Drift = 1200 / 60000 = 2.0 %
  const bPos = [mockPosition({ symbol: "BTCUSDT", qty: 0.1, entryPrice: 61200 })];
  const dPos = [mockDbPosition({ symbol: "BTCUSDT", qty: 0.1, entryPrice: 60000 })];
  const diffs = classifyDifferences({
    brokerPositions: bPos,
    brokerAccount: mockAccount({ cash: 3880, equity: 10000 }),
    dbPositions: dPos,
    dbAccount: { cash: 3880, equity: 10000 },
    config: defaultConfig(),
    isPaper: false,
  });

  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].type, "PRICE_DRIFT");
  assert.equal(diffs[0].critical, true, "Überschreitung der Drift-Toleranz ist kritisch");
});

test("Klassifikation: QTY_MISMATCH → critical=true", () => {
  // Broker meldet 0.15, DB hat 0.10
  const bPos = [mockPosition({ symbol: "BTCUSDT", qty: 0.15, entryPrice: 60000 })];
  const dPos = [mockDbPosition({ symbol: "BTCUSDT", qty: 0.10, entryPrice: 60000 })];
  const diffs = classifyDifferences({
    brokerPositions: bPos,
    brokerAccount: mockAccount(),
    dbPositions: dPos,
    config: defaultConfig(),
    isPaper: false,
  });

  const qtyMismatch = diffs.find((d) => d.type === "QTY_MISMATCH");
  assert.ok(qtyMismatch, "QTY_MISMATCH muss gefunden werden");
  assert.equal(qtyMismatch.critical, true);
  assert.equal(qtyMismatch.diff, 0.05);
});

test("Klassifikation: PHANTOM_POSITION (nur Broker) → critical=true", () => {
  // Broker hat SOLUSDT, DB hat nichts
  const bPos = [mockPosition({ symbol: "SOLUSDT", qty: 10, entryPrice: 150 })];
  const dPos: DbPositionSnapshot[] = [];
  const diffs = classifyDifferences({
    brokerPositions: bPos,
    brokerAccount: mockAccount(),
    dbPositions: dPos,
    config: defaultConfig(),
    isPaper: false,
  });

  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].type, "PHANTOM_POSITION");
  assert.equal(diffs[0].critical, true);
  assert.equal(diffs[0].symbol, "SOLUSDT");
});

test("Klassifikation: MISSING_POSITION (nur DB) → critical=true", () => {
  // DB hat ETHUSDT, Broker hat nichts
  const bPos: BrokerPosition[] = [];
  const dPos = [mockDbPosition({ symbol: "ETHUSDT", qty: 1.0, entryPrice: 3000 })];
  const diffs = classifyDifferences({
    brokerPositions: bPos,
    brokerAccount: mockAccount(),
    dbPositions: dPos,
    config: defaultConfig(),
    isPaper: false,
  });

  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].type, "MISSING_POSITION");
  assert.equal(diffs[0].critical, true);
  assert.equal(diffs[0].symbol, "ETHUSDT");
});

test("Klassifikation: BALANCE_MISMATCH → critical=true", () => {
  const bPos: BrokerPosition[] = [];
  const dPos: DbPositionSnapshot[] = [];
  const diffs = classifyDifferences({
    brokerPositions: bPos,
    brokerAccount: mockAccount({ cash: 10000, equity: 10000 }),
    dbPositions: dPos,
    dbAccount: { cash: 9200, equity: 9200 },
    config: defaultConfig(),
    isPaper: false,
  });

  const balanceMismatch = diffs.find((d) => d.type === "BALANCE_MISMATCH");
  assert.ok(balanceMismatch, "BALANCE_MISMATCH muss gemeldet werden");
  assert.equal(balanceMismatch.critical, true);
  assert.equal(balanceMismatch.diff, 800);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pause-Pfad (D2)
// ─────────────────────────────────────────────────────────────────────────────

test("Pause-Pfad: RECON_PAUSE_ON_MISMATCH=false → nur Report/Audit, Kill-Switch bleibt frei", async () => {
  const audits: AuditRecord[] = [];
  const alerts: Alert[] = [];
  const adapter = new MockAdapter(
    [mockPosition({ symbol: "BTCUSDT", qty: 0.2 })], // Mismatch vs DB (0.1)
  );
  const dbStore = new MockDbStore({
    positions: [mockDbPosition({ symbol: "BTCUSDT", qty: 0.1 })],
  });

  const report = await runReconciliation(adapter, dbStore, {
    config: { pauseOnMismatch: false, priceDriftPct: 1, intervalMinutes: 60 },
    auditSink: async (rec) => {
      audits.push(rec);
    },
    alertSink: async (alert) => {
      alerts.push(alert);
    },
  });

  assert.equal(report.clean, false);
  assert.equal(report.paused, false, "Ohne pauseOnMismatch darf kein Pause ausgelöst werden");
  assert.equal(killSwitch.isArmed(), false, "Kill-Switch muss unbewaffnet bleiben");
  assert.equal(dbStore.killSwitchRecords.length, 0);

  // Audit und Alert müssen trotzdem geschrieben worden sein
  assert.ok(audits.some((a) => a.event === "RECONCILIATION_DISCREPANCY"));
  assert.ok(alerts.some((a) => a.code === "recon:qty_mismatch"));
});

test("Pause-Pfad: RECON_PAUSE_ON_MISMATCH=true → Kill-Switch ENGAGE mit Grund „recon:<klasse>“, Disarm bleibt challenge-geschützt", async () => {
  const audits: AuditRecord[] = [];
  const alerts: Alert[] = [];
  const adapter = new MockAdapter(
    [mockPosition({ symbol: "BTCUSDT", qty: 0.25 })], // QTY_MISMATCH vs DB (0.10)
  );
  const dbStore = new MockDbStore({
    positions: [mockDbPosition({ symbol: "BTCUSDT", qty: 0.10 })],
  });

  const report = await runReconciliation(adapter, dbStore, {
    config: { pauseOnMismatch: true, priceDriftPct: 1, intervalMinutes: 60 },
    auditSink: async (rec) => {
      audits.push(rec);
    },
    alertSink: async (alert) => {
      alerts.push(alert);
    },
  });

  assert.equal(report.clean, false);
  assert.equal(report.paused, true, "Pause muss ausgelöst sein");
  assert.equal(report.pauseReason, "recon:QTY_MISMATCH");
  assert.equal(killSwitch.isArmed(), true, "Kill-Switch MUSS scharfgestellt sein");

  // DB-Zeile für Kill-Switch erzeugt
  assert.equal(dbStore.killSwitchRecords.length, 1);
  assert.equal(dbStore.killSwitchRecords[0].reason, "recon:QTY_MISMATCH");
  assert.equal(dbStore.killSwitchRecords[0].triggeredBy, "RECONCILIATION");
  assert.equal(dbStore.killSwitchRecords[0].armed, true);

  // Audit-Log enthält KILL_SWITCH Mutation
  assert.ok(
    audits.some(
      (a) => a.event === "KILL_SWITCH" && (a.detail as Record<string, unknown> | undefined)?.reason === "recon:QTY_MISMATCH"
    )
  );

  // Auto-Flatten ist VERBOTEN: Keine Glattstellung, Positionen im Mock-Adapter bleiben unverändert
  assert.equal(adapter.positions.length, 1, "Auto-Flatten ist verboten: Positionen bleiben unverändert");

  // Disarm-Challenge bleibt unverändert und verlangt einen gültigen Nonce
  assert.equal(consumeDisarmNonce("ungueltig", Date.now()), "missing");
  assert.equal(killSwitch.isArmed(), true, "Kill-Switch bleibt scharf bei unberechtigtem Disarm");

  const { nonce } = issueDisarmNonce();
  assert.equal(consumeDisarmNonce(nonce, Date.now()), "ok");
  killSwitch.disarm();
  assert.equal(killSwitch.isArmed(), false, "Nach manuellem Challenge-Disarm ist Switch frei");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Client-Order-ID & Idempotenz (D3)
// ─────────────────────────────────────────────────────────────────────────────

test("Idempotenz: buildClientOrderId erzeugt kanonisches Schema „atf-<intentId-kurz>“", () => {
  const intent1 = "01920ef0-48a6-78e2-9d7a-d02e4827011a";
  const id1 = buildClientOrderId(intent1);
  assert.match(id1, /^atf-[a-z0-9]{4,32}$/);
  assert.equal(id1, "atf-01920ef048a6");

  // Deterministisch: identische Intent-ID → identische clientOrderId
  assert.equal(buildClientOrderId(intent1), id1);

  // Unterschiedliche Intent-IDs → unterschiedliche clientOrderIds
  const intent2 = "02920ef0-48a6-78e2-9d7a-d02e4827011b";
  assert.notEqual(buildClientOrderId(intent2), id1);
});

test("Idempotenz: Timeout nach Submit (Mock), Retry mit gleicher clientOrderId → genau eine Order", async () => {
  const intentId = "01920ef0-48a6-78e2-9d7a-d02e4827011a";
  const orderReq: BrokerOrderRequest = {
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 0.1,
    limitPrice: 60000,
    riskNotional: 6000,
  };

  const dbStore = new MockDbStore({
    intents: [
      {
        id: intentId,
        account: "PAPER",
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 0.1,
        status: "RESERVED",
      },
    ],
  });

  // Simuliere einen Adapter mit Timeout-Verhalten:
  // Der erste Call nimmt die Order an, wirft aber einen Netzwerk-Timeout.
  // Der zweite Call (Retry) erkennt die identische clientOrderId über den Venue-Dedupe-Speicher.
  let callCount = 0;
  const venueStore = new Map<string, BrokerOrderResult>();

  const retryAdapter: BrokerAdapter = {
    id: "PAPER",
    mode: "paper",
    capabilities: {
      discovery: true,
      marketData: true,
      trading: true,
      paper: true,
      testnet: false,
      live: false,
      instrumentTypes: { spot: true, perpetual: true, future: false, option: false },
      stopAtVenue: false,
    },
    async healthCheck() {
      return { status: "online", latencyMs: 1, details: {} };
    },
    async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
      callCount++;
      const cid = req.clientOrderId!;
      // Wenn die Order bereits am Venue eingegangen ist:
      if (venueStore.has(cid)) {
        return venueStore.get(cid)!;
      }
      const orderRes: BrokerOrderResult = {
        orderId: `venue-order-${callCount}`,
        symbol: req.symbol,
        side: req.side,
        qty: req.qty,
        fillPrice: req.limitPrice ?? 60000,
        status: "FILLED",
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      };
      venueStore.set(cid, orderRes);

      // Beim ersten Call simulieren wir Timeout NACH Eingang am Venue:
      if (callCount === 1) {
        throw new Error("ETIMEDOUT: Connection timed out after sending order");
      }
      return orderRes;
    },
  };

  // Erster Submit scheitert an Timeout
  await assert.rejects(
    () => submitWithIntent({ orderIntentId: intentId, order: orderReq, adapter: retryAdapter, dbStore }),
    /ETIMEDOUT/
  );

  // Retry mit DEMSELBEN orderIntent
  const retryResult = await submitWithIntent({
    orderIntentId: intentId,
    order: orderReq,
    adapter: retryAdapter,
    dbStore,
  });

  assert.equal(retryResult.status, "FILLED");
  assert.equal(retryResult.orderId, "venue-order-1", "Derselbe Fill vom ersten Eingang am Venue");
  assert.equal(callCount, 2, "Zwei Aufrufe am Adapter (1. Timeout, 2. Retry)");
  assert.equal(venueStore.size, 1, "Genau EINE Order im Venue-Store — kein Doppel-Order!");

  // DB-Status konsistent aktualisiert
  const intentRow = dbStore.intents.find((i) => i.id === intentId);
  assert.equal(intentRow?.status, "FILLED");

  // Dritter Submit greift nun zusätzlich über lokale orderIntent-Deduplizierung
  const thirdSubmit = await submitWithIntent({
    orderIntentId: intentId,
    order: orderReq,
    adapter: retryAdapter,
    dbStore,
  });
  assert.equal(thirdSubmit.status, "FILLED");
  assert.equal(thirdSubmit.reason, "IDEMPOTENT_DEDUPE_LOCAL");
  assert.equal(callCount, 2, "Kein weiterer Venue-Call — lokale DB-Dedupe griff vorher");

  // Zweiter unabhängiger Intent → erzeugt neue zweite Order
  const secondIntentId = "02920ef0-48a6-78e2-9d7a-d02e4827011b";
  const secondResult = await submitWithIntent({
    orderIntentId: secondIntentId,
    order: orderReq,
    adapter: retryAdapter,
    dbStore,
  });
  assert.equal(secondResult.status, "FILLED");
  assert.equal(callCount, 3);
  assert.equal(venueStore.size, 2, "Zweiter Intent erzeugt genau eine zweite Order");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Paper-Invarianz-Selbsttest (D4)
// ─────────────────────────────────────────────────────────────────────────────

test("Paper-Invarianz: gesundes Ledger → keine Befunde", () => {
  // Invarianten:
  // freeCash = 4000 >= 0
  // Position: qty = 0.1, entryPrice = 60000, lastPrice = 60000 -> Notional = 6000, Einstand = 6000, uPnL = 0
  // Summe Notional = 6000 <= Equity (10000)
  // Equity = 4000 + 6000 + 0 = 10000
  const bPos = [mockPosition({ qty: 0.1, entryPrice: 60000, lastPrice: 60000, unrealizedPnl: 0 })];
  const dPos = [mockDbPosition({ qty: 0.1, entryPrice: 60000, currentPrice: 60000 })];

  const diffs = classifyDifferences({
    brokerPositions: bPos,
    brokerAccount: mockAccount({ cash: 4000, equity: 10000 }),
    dbPositions: dPos,
    dbAccount: { cash: 4000, equity: 10000 },
    config: defaultConfig(),
    isPaper: true, // Paper-Invarianzen aktiv
  });

  const invDiffs = diffs.filter((d) => d.type === "INVARIANT_VIOLATION");
  assert.equal(invDiffs.length, 0, "Keine Invarianten-Verletzungen in gesundem Ledger erwartet");
});

test("Paper-Invarianz: manipuliertes Fixture mit negativem Cash → INVARIANT_VIOLATION + Audit", async () => {
  const audits: AuditRecord[] = [];
  const alerts: Alert[] = [];
  // Manipuliert: negatives Cash (-250 €)
  const adapter = new MockAdapter(
    [mockPosition({ qty: 0.1, entryPrice: 60000 })],
    { cash: -250, equity: 5750 }
  );
  const dbStore = new MockDbStore({
    positions: [mockDbPosition({ qty: 0.1, entryPrice: 60000 })],
  });

  const report = await runReconciliation(adapter, dbStore, {
    config: { pauseOnMismatch: false, priceDriftPct: 1, intervalMinutes: 60 },
    auditSink: async (rec) => {
      audits.push(rec);
    },
    alertSink: async (alert) => {
      alerts.push(alert);
    },
  });

  const violation = report.discrepancies.find(
    (d) => d.type === "INVARIANT_VIOLATION" && d.detail.includes("freeCash < 0")
  );
  assert.ok(violation, "freeCash < 0 muss als INVARIANT_VIOLATION gemeldet werden");
  assert.equal(violation.critical, true);

  // Revisionssicherer Audit
  assert.ok(
    audits.some(
      (a) =>
        a.event === "RECONCILIATION_DISCREPANCY" &&
        (a.detail as Record<string, unknown> | undefined)?.type === "INVARIANT_VIOLATION"
    )
  );

  // Alert über AlertSink
  assert.ok(alerts.some((a) => a.code === "recon:invariant_violation"));
});

test("Paper-Invarianz: Summe Notional > Equity → INVARIANT_VIOLATION", () => {
  // Notional = 0.5 * 60000 = 30000 > Equity (10000)
  const bPos = [mockPosition({ qty: 0.5, entryPrice: 60000, lastPrice: 60000 })];
  const dPos = [mockDbPosition({ qty: 0.5, entryPrice: 60000 })];

  const diffs = classifyDifferences({
    brokerPositions: bPos,
    brokerAccount: mockAccount({ cash: 0, equity: 10000 }),
    dbPositions: dPos,
    config: defaultConfig(),
    isPaper: true,
  });

  const violation = diffs.find(
    (d) => d.type === "INVARIANT_VIOLATION" && d.detail.includes("Summe Notional")
  );
  assert.ok(violation, "Summe Notional > Equity muss abgewiesen werden");
});

test("Paper-Invarianz: fehlerhafte Equity-Formel (Equity ≠ Cash + Einstand + uPnL) → INVARIANT_VIOLATION", () => {
  // Cash = 4000, Einstand = 6000, uPnL = 0 -> Erwartete Equity = 10000; Gemeldet aber: 12000
  const bPos = [mockPosition({ qty: 0.1, entryPrice: 60000, lastPrice: 60000, unrealizedPnl: 0 })];
  const dPos = [mockDbPosition({ qty: 0.1, entryPrice: 60000 })];

  const diffs = classifyDifferences({
    brokerPositions: bPos,
    brokerAccount: mockAccount({ cash: 4000, equity: 12000 }), // Inkonsistente Equity!
    dbPositions: dPos,
    config: defaultConfig(),
    isPaper: true,
  });

  const violation = diffs.find(
    (d) => d.type === "INVARIANT_VIOLATION" && d.detail.includes("freeCash")
  );
  assert.ok(violation, "Inkonsistente Equity-Formel muss als INVARIANT_VIOLATION gemeldet werden");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Scheduler & CLI-Run
// ─────────────────────────────────────────────────────────────────────────────

test("Scheduler-Intervall mit Fake-Clock & Persistenz", async () => {
  const tmpReportFile = path.join("data", "reconciliation", `test-report-${Date.now()}.json`);
  const adapter = new MockAdapter();
  const dbStore = new MockDbStore();

  let fakeNow = 1700000000000;
  const rep1 = await runReconciliation(adapter, dbStore, {
    reportFile: tmpReportFile,
    now: fakeNow,
    config: { intervalMinutes: 30, priceDriftPct: 1, pauseOnMismatch: false },
  });

  assert.equal(rep1.clean, true);
  assert.equal(existsSync(tmpReportFile), true, "Report-Datei muss geschrieben worden sein");

  const content = JSON.parse(readFileSync(tmpReportFile, "utf8"));
  assert.equal(content.clean, true);
  assert.equal(content.summary.total, 0);

  // Zeit um 30 Minuten vorstellen
  fakeNow += 30 * 60 * 1000;
  const rep2 = await runReconciliation(adapter, dbStore, {
    reportFile: tmpReportFile,
    now: fakeNow,
  });
  assert.equal(rep2.ts, new Date(fakeNow).toISOString());

  // Aufräumen
  try {
    unlinkSync(tmpReportFile);
  } catch {
    /* ignore */
  }
});
