import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PaperBroker } from "../src/lib/broker";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";

function order(overrides: Partial<Parameters<PaperBroker["submit"]>[0]> = {}) {
  return {
    symbol: "BTC",
    side: "LONG" as const,
    qty: 0.1,
    riskNotional: 1000,
    stopLoss: 60000,
    takeProfit: 70000,
    ...overrides,
  };
}

beforeEach(() => {
  resetRuntimeLimits();
  killSwitch.disarm();
});

test("Broker: saubere Order wird gefüllt, Position erscheint", () => {
  const b = new PaperBroker(10000);
  const fill = b.submit(order());
  assert.equal(fill.status, "FILLED");
  assert.ok(fill.fillPrice > 0);
  assert.equal(b.openPositions, 1);
  const pos = b.getPosition("BTC");
  assert.equal(pos?.qty, 0.1);
});

test("Broker: Kill-Switch blockt jede neue Order", () => {
  const b = new PaperBroker(10000);
  killSwitch.pull("test");
  const fill = b.submit(order());
  assert.equal(fill.status, "REJECTED");
  assert.match(fill.reason ?? "", /KILL_SWITCH_ARMED/);
});

test("Broker: kein Nachkauf — zweite Order für dasselbe Symbol wird abgelehnt", () => {
  const b = new PaperBroker(10000);
  assert.equal(b.submit(order()).status, "FILLED");
  const second = b.submit(order());
  assert.equal(second.status, "REJECTED");
  assert.match(second.reason ?? "", /POSITION_ALREADY_OPEN/);
});

test("Broker: fehlender Stop-Loss wird abgelehnt (Guardrail, nicht Modell-Ermessen)", () => {
  const b = new PaperBroker(10000);
  const fill = b.submit(order({ stopLoss: undefined }));
  assert.equal(fill.status, "REJECTED");
  assert.match(fill.reason ?? "", /stop-loss:mandatory/);
});

test("Broker: ungültige Symbole und Zahlen werden abgelehnt, nicht geraten", () => {
  const b = new PaperBroker(10000);
  assert.equal(b.submit(order({ symbol: 'BTC"; DROP TABLE positions; --' })).status, "REJECTED");
  assert.equal(b.submit(order({ symbol: "BTC&foo=bar" })).status, "REJECTED");
  assert.equal(b.submit(order({ qty: NaN })).status, "REJECTED");
  assert.equal(b.submit(order({ qty: -1 })).status, "REJECTED");
  assert.equal(b.submit(order({ riskNotional: Infinity })).status, "REJECTED");
  assert.equal(b.submit(order({ stopLoss: -1 })).status, "REJECTED");
  assert.equal(b.submit(order({ stopLoss: NaN })).status, "REJECTED");
  assert.match(b.submit(order({ stopLoss: NaN })).reason ?? "", /INVALID_STOP_LOSS/);
});

test("Broker: Order weit über jede Grenze → Positions-Guardrail blockt (defense in depth)", () => {
  const b = new PaperBroker(10000);
  const fill = b.submit(order({ riskNotional: 25_000 }));
  assert.equal(fill.status, "REJECTED");
  assert.match(fill.reason ?? "", /position-size:max-25%-of-equity/);
});

test("Broker: close realisiert P&L korrekt inkl. Paper-Slippage", () => {
  const b = new PaperBroker(10000);
  // ETH statisch = 3200 → Fill = 3203,20. qty 0.5 → Notional 1600 ≤ 25 % Equity.
  const fillNow = b.submit(order({ symbol: "ETH", qty: 0.5, riskNotional: 1600, stopLoss: 3000, takeProfit: 3500 }));
  assert.equal(fillNow.status, "FILLED");
  const closed = b.close("ETH", "TAKE_PROFIT");
  assert.ok(closed != null, "Position muss schließbar sein");
  // Slippage: -0.1 % auf 3200 = -1.60 € (statisches Buch = Einstieg nach Slippage).
  assert.ok(Math.abs(closed.realizedPnl - (-1.6)) < 0.01, `realizedPnl=${closed.realizedPnl}`);
  assert.equal(b.openPositions, 0);
  // Kapital ist erhalten (nur Slippage-Kosten), nie "weg".
  assert.ok(Math.abs(b.accountEquity - 9998.4) < 0.5, `equity=${b.accountEquity}`);
});

test("Broker: hydrate OHNE cashHint = alte Logik (startEquity − Einstiege)", () => {
  const b = new PaperBroker(10000);
  b.hydrate([{ symbol: "BTC", side: "LONG", qty: 0.1, entryPrice: 60000 }]);
  assert.equal(b.freeCash, 10000 - 6000);
  assert.equal(b.openPositions, 1);
});

test("Regression v1.1.0: hydrate MIT cashHint erhält realisiertes P&L (Neustart-Fix)", () => {
  // Szenario: Trade geschlossen (+200 €), Neustart, Cash laut letztem Snapshot = 10200.
  const b = new PaperBroker(10000);
  b.hydrate([], { cashHint: 10200 });
  assert.equal(b.freeCash, 10200, "Cash aus Snapshot muss erhalten bleiben");

  // Offene Position + korrekter Cash aus Snapshot: equity = cash + Marktwert.
  b.hydrate([{ symbol: "BTC", side: "LONG", qty: 0.1, entryPrice: 60000 }], { cashHint: 4000 });
  const equity = b.accountEquity; // 4000 + 0.1 * 67000 (statisch)
  assert.ok(Math.abs(equity - (4000 + 0.1 * 67000)) < 1e-6, `equity=${equity}`);
});

test("Regression v1.5.2: hydrate erhält stopLoss/takeProfit (Dashboard-Wahrheit nach Neustart)", () => {
  // Vor dem Fix schmiss getBroker SL/TP beim Hydrat-Mapping weg — das Dashboard
  // zeigte nach jedem Neustart "kein Stop-Loss", obwohl die DB ihn hat.
  const b = new PaperBroker(10000);
  b.hydrate(
    [
      { symbol: "BTC", side: "LONG", qty: 0.1, entryPrice: 60000, stopLoss: 57000, takeProfit: 72000 },
      // Ungültige SL/TP-Werte (NaN/negativ) dürfen nicht durchsickern → null.
      { symbol: "ETH", side: "LONG", qty: 1, entryPrice: 3000, stopLoss: NaN, takeProfit: -5 },
    ],
    { cashHint: 4000 },
  );
  const btc = b.listPositions().find((p) => p.symbol === "BTC");
  assert.ok(btc, "BTC-Position muss hydratiert sein");
  assert.equal(btc?.stopLoss, 57000, "stopLoss muss nach Hydration erhalten sein");
  assert.equal(btc?.takeProfit, 72000, "takeProfit muss nach Hydration erhalten sein");
  const eth = b.listPositions().find((p) => p.symbol === "ETH");
  assert.equal(eth?.stopLoss ?? null, null, "NaN-stopLoss → null");
  assert.equal(eth?.takeProfit ?? null, null, "negativer takeProfit → null");
});

test("Broker: hydrate ignoriert kaputte Zeilen (qty<=0, NaN, falsche Side)", () => {
  const b = new PaperBroker(10000);
  b.hydrate(
    [
      { symbol: "BTC", side: "LONG", qty: -1, entryPrice: 60000 },
      { symbol: "ETH", side: "LONG", qty: NaN, entryPrice: 3000 },
      { symbol: "SOL", side: "LONG", qty: 1, entryPrice: 0 },
      // gültige Zeile:
      { symbol: "AAPL", side: "LONG", qty: 10, entryPrice: 100 },
    ] as never,
    { cashHint: 5000 }
  );
  assert.equal(b.openPositions, 1);
  assert.equal(b.getPosition("AAPL")?.qty, 10);
});

test("Broker: closeAll stellt alles glatt und liefert fills", () => {
  const b = new PaperBroker(10000);
  b.submit(order({ symbol: "BTC", riskNotional: 1000 }));
  b.submit(order({ symbol: "ETH", riskNotional: 1000 }));
  const fills = b.closeAll("MANUAL_FLATTEN");
  assert.equal(fills.length, 2);
  assert.equal(b.openPositions, 0);
});
