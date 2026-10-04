/**
 * Regressionstests fuer die Laufzeitgrenze des Reports.
 *
 * Ein geschuetzter Report-Endpunkt darf seinen 401-Fehlerbody nie in den
 * Render-State der Reports-Ansicht durchreichen: Der Body besitzt keine
 * `summary`-/Listenfelder und fuehrte nach v0.15.0 zu `undefined.length`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isReportData } from "../src/lib/reportResponse";

const VALID_REPORT = {
  ok: true,
  period: "day",
  since: "2026-10-04T00:00:00.000Z",
  kpis: {
    trades: 0,
    realizedPnl: 0,
    winRate: null,
    profitFactor: null,
    bestTrade: null,
    worstTrade: null,
    maxDrawdownPct: 0,
    stopLossHits: 0,
    takeProfitHits: 0,
  },
  symbols: [],
  turnsByRole: {},
  decisionsByType: {},
  blocks: [],
  notableEvents: [],
  recommendations: [],
  summary: [],
};

test("Report-Vertrag akzeptiert eine vollstaendige erfolgreiche Antwort", () => {
  assert.equal(isReportData(VALID_REPORT), true);
});

test("401-Fehlerbody wird nicht als Report akzeptiert", () => {
  assert.equal(
    isReportData({
      ok: false,
      error: "UNAUTHORIZED",
      hint: "Fehlende Session",
    }),
    false,
  );
});

test("unvollstaendiger Erfolgsbody wird nicht gerendert", () => {
  const malformed = { ...VALID_REPORT, summary: undefined };
  assert.equal(isReportData(malformed), false);
});
