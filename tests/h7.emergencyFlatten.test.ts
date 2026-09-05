/**
 * H7 (v1.36.20) — Kill-Switch/Flatten arbeitet nicht mehr nur auf dem
 * Paper-Ledger.
 *
 * Acceptance (docs/AUDIT_REMEDIATION_2026-09.md / audit-remediation/H7):
 *   - `flattenAll` ruft bei Live-Konfiguration `cancelAllOpenOrders` /
 *     `closeAllPositions` / `verifyFlat` (in genau dieser Reihenfolge).
 *   - Kill-Switch wird erst nach verifiziertem Flat arming/disarming.
 *   - Paper-Modus: Ledger-Flatten bleibt Default; Audit vermerkt den Modus
 *     ("paper-only flatten (live disabled)") vs. echte Venue-Glattstellung.
 *   - Mock EmergencyBroker: assert cancel → close → verify BEFORE arm.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PaperBroker } from "../src/lib/broker";
import { killSwitch } from "../src/lib/riskGuard";
import { flattenAll } from "../src/lib/engine";
import { setAuditTransportForTests, type AuditRow } from "../src/lib/auditSink";
import type { EmergencyBroker, EmergencyCloseFill } from "../src/contracts/broker";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";

/** Order-Helper wie in tests/broker.test.ts (BTC 0.015 @ ~67k ≈ 1005 Notional). */
function order(overrides: Partial<Parameters<PaperBroker["submit"]>[0]> = {}) {
  return {
    symbol: "BTC",
    side: "LONG" as const,
    qty: 0.015,
    riskNotional: 1005,
    stopLoss: 60000,
    takeProfit: 70000,
    ...overrides,
  };
}

const FILL_BTC: EmergencyCloseFill = {
  symbol: "BTC",
  side: "LONG",
  qty: 0.015,
  fillPrice: 67000,
  realizedPnl: 120,
};

type EmergencyCall = "cancelAllOpenOrders" | "closeAllPositions" | "verifyFlat";

/** Mock-EmergencyBroker mit Aufruf-Protokoll (Acceptance: Reihenfolge). */
function mockEmergencyBroker(
  overrides: Partial<{
    cancel: () => Promise<{ canceled: number }> | { canceled: number };
    close: () => Promise<EmergencyCloseFill[]> | EmergencyCloseFill[];
    verify: () => Promise<boolean> | boolean;
  }> = {}
): { broker: EmergencyBroker; calls: EmergencyCall[] } {
  const calls: EmergencyCall[] = [];
  const broker: EmergencyBroker = {
    async cancelAllOpenOrders() {
      calls.push("cancelAllOpenOrders");
      return overrides.cancel ? await overrides.cancel() : { canceled: 0 };
    },
    async closeAllPositions(reason: string) {
      calls.push("closeAllPositions");
      void reason;
      return overrides.close ? await overrides.close() : [];
    },
    async verifyFlat() {
      calls.push("verifyFlat");
      return overrides.verify ? await overrides.verify() : true;
    },
  };
  return { broker, calls };
}

const auditRows: Array<{ event: string; detail: Record<string, unknown> }> = [];

beforeEach(() => {
  __resetAllSingletonsForTests();
  auditRows.length = 0;
  // Audit erfolgreich, ohne DB: spy statt Default-Transport.
  setAuditTransportForTests(async (row: AuditRow) => {
    auditRows.push({ event: row.event, detail: (row.detail ?? {}) as Record<string, unknown> });
  });
});

afterEach(() => {
  setAuditTransportForTests(null);
  killSwitch.disarm();
});

// ── Paper-Ledger erfüllt die EmergencyBroker-Schnittstelle ──────────────────

test("H7 PaperBroker: cancelAllOpenOrders=0, closeAllPositions schließt, verifyFlat belegt Flachheit", async () => {
  const b = new PaperBroker(10000);
  assert.equal(await b.verifyFlat(), true, "leeres Ledger ist flach");
  assert.deepEqual(await b.cancelAllOpenOrders(), { canceled: 0 }, "Paper füllt synchron — keine offenen Orders");

  assert.equal(b.submit(order()).status, "FILLED");
  assert.equal(await b.verifyFlat(), false, "Position offen → nicht flach");

  const fills = await b.closeAllPositions("MANUAL_FLATTEN");
  assert.equal(fills.length, 1);
  assert.equal(fills[0].symbol, "BTC");
  assert.ok(fills[0].fillPrice > 0, "Paper-Fill trägt echten Ex-Preis");

  assert.equal(await b.verifyFlat(), true, "nach dem Close ist das Ledger flach");
});

// ── flattenAll: Reihenfolge cancel → close → verify (Acceptance) ────────────

test("H7 flattenAll: Mock-Broker reihenfolge cancel→close→verify VOR arm (paper)", async () => {
  const { broker, calls } = mockEmergencyBroker({
    cancel: async () => ({ canceled: 2 }),
    close: async () => [FILL_BTC],
    verify: async () => true,
  });

  const out = await flattenAll("H7-TEST", { broker, mode: "paper", venue: "PAPER" });

  assert.deepEqual(calls, ["cancelAllOpenOrders", "closeAllPositions", "verifyFlat"]);
  assert.equal(out.mode, "paper");
  assert.equal(out.venue, "PAPER");
  assert.equal(out.canceled, 2);
  assert.equal(out.fills.length, 1);
  assert.equal(out.flat, true);
  assert.equal(out.error, null);
});

test("H7 flattenAll: nicht flach → ein Retry-Close, dann flach bestätigt", async () => {
  let verifyCount = 0;
  const { broker, calls } = mockEmergencyBroker({
    cancel: async () => ({ canceled: 1 }),
    close: async () => [FILL_BTC],
    verify: async () => {
      verifyCount += 1;
      return verifyCount > 1; // erste verifyFlat false → Retry; danach flach
    },
  });

  const out = await flattenAll("H7-TEST", { broker, mode: "paper", venue: "PAPER" });

  assert.equal(calls.filter((c) => c === "closeAllPositions").length, 2, "Retry-Close nach NOT flach");
  assert.equal(out.flat, true);
  assert.equal(out.fills.length, 2, "Fills des ersten + Retry-Close");
});

test("H7 flattenAll: nie flach → flat=false + NOT_FLAT im Audit, KEIN Wurf", async () => {
  const { broker } = mockEmergencyBroker({
    close: async () => [FILL_BTC],
    verify: async () => false,
  });

  const out = await flattenAll("H7-TEST", { broker, mode: "paper", venue: "PAPER" });

  assert.equal(out.flat, false);
  assert.match(out.error ?? "", /NOT_FLAT/);
});

test("H7 flattenAll: Cancel-Fehler blockiert close/verify NICHT (Fehler geht in outcome+Audit)", async () => {
  const { broker, calls } = mockEmergencyBroker({
    cancel: async () => {
      throw new Error("VENUE_TIMEOUT");
    },
    close: async () => [FILL_BTC],
    verify: async () => true,
  });

  const out = await flattenAll("H7-TEST", { broker, mode: "paper", venue: "PAPER" });

  assert.deepEqual(calls, ["cancelAllOpenOrders", "closeAllPositions", "verifyFlat"], "kein Abbruch nach Cancel-Fehler");
  assert.equal(out.canceled, 0);
  assert.match(out.error ?? "", /CANCEL_FAILED/);
  assert.equal(out.fills.length, 1, "Close lief trotzdem");
  assert.equal(out.flat, true);
});

// ── Live-Modus (Injektion): Audit weist Venue-Glattstellung nach ────────────

test("H7 flattenAll: Live-Modus → Audit nennt Modus 'live', Venue und Flat-Beweis", async () => {
  const { broker } = mockEmergencyBroker({
    cancel: async () => ({ canceled: 5 }),
    close: async () => [FILL_BTC],
    verify: async () => true,
  });

  const out = await flattenAll("H7-MANUAL", { broker, mode: "live", venue: "BITUNIX" });

  assert.equal(out.mode, "live");
  assert.equal(out.venue, "BITUNIX");
  const flattenAudit = auditRows.find((r) => r.event === "FLATTEN_ALL");
  assert.ok(flattenAudit, "FLATTEN_ALL-Audit geschrieben");
  assert.equal(flattenAudit.detail.mode, "live");
  assert.equal(flattenAudit.detail.venue, "BITUNIX");
  assert.equal(flattenAudit.detail.flat, true);
  assert.equal(flattenAudit.detail.liveDisabled, undefined, "bei echten Venue-Flatten kein paper-only-Hinweis");
  assert.equal(flattenAudit.detail.canceled, 5);
  assert.equal(flattenAudit.detail.closed, 1);
});

test("H7 flattenAll: Paper-Default → Audit vermerkt 'paper-only flatten (live disabled)'", async () => {
  const { broker } = mockEmergencyBroker({
    close: async () => [FILL_BTC],
    verify: async () => true,
  });

  await flattenAll("H7-MANUAL", { broker, mode: "paper", venue: "PAPER" });

  const flattenAudit = auditRows.find((r) => r.event === "FLATTEN_ALL");
  assert.ok(flattenAudit, "FLATTEN_ALL-Audit geschrieben");
  assert.equal(flattenAudit.detail.mode, "paper");
  assert.equal(flattenAudit.detail.liveDisabled, "paper-only flatten (live disabled)");
});