/**
 * Tests der Equity-Alarme (`src/lib/monitor.ts` → `checkEquityAlerts`).
 *
 * Die Alarme sind Beobachtung, kein Handelspfad: sie dürfen den Tick nie
 * brechen, dürfen nicht fluten (Debounce/Ratchet) und dürfen nichts erfinden
 * (ungültige Schwellen fallen weg, statt bei jedem Tick zu feuern).
 *
 * Bewusst ohne DB: `checkEquityAlerts` bekommt Zähler und Zustand injiziert —
 * die Testfälle prüfen die Logik, nicht den Alert-Adapter (der hat eigene
 * Tests über `tests/alertDispatcher*`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkEquityAlerts,
  parseEquityAlertThresholds,
  EQUITY_ALERT_DEFAULT_THRESHOLDS,
  EQUITY_ALERT_ENV,
  type EquityAlertState,
} from "../src/lib/monitor";

type Sent = { code: string; severity: string; message: string };

function collector() {
  const sent: Sent[] = [];
  const emit = (async (alert: Sent) => {
    sent.push(alert);
    return { sent: true, suppressed: false } as unknown as never;
  }) as unknown as Parameters<typeof checkEquityAlerts>[0]["emit"];
  return { sent, emit };
}

test("parseEquityAlertThresholds: Default, Sortierung, Dedupe und Müll raus", () => {
  assert.deepEqual(parseEquityAlertThresholds(undefined), [...EQUITY_ALERT_DEFAULT_THRESHOLDS]);
  assert.deepEqual(parseEquityAlertThresholds("20, 5,10,10,3.5"), [3.5, 5, 10, 20]);
  // 0 % würde bei jedem Tick feuern, 0/negativ/„abc“/>100 fallen weg.
  assert.deepEqual(parseEquityAlertThresholds("0,-5,abc,101"), []);
  assert.deepEqual(parseEquityAlertThresholds(""), []);
});

test("neues Hoch meldet genau einmal; kleine Schwankungen nicht", async () => {
  const { sent, emit } = collector();
  const state: EquityAlertState = { peak: 10_000, threshold: 0 };

  // +0,2 % liegt unter EQUITY_ALERT_PEAK_MIN_PCT (0,5 %) → kein Alarm.
  const small = await checkEquityAlerts({ equity: 10_020, drawdownPct: 0, emit, state });
  assert.equal(small.peak, false);
  assert.equal(sent.length, 0);
  // Der stille Peak wird trotzdem nachgeführt (kein „Rückstand“).
  assert.equal(state.peak, 10_020);

  const big = await checkEquityAlerts({ equity: 10_100, drawdownPct: 0, emit, state });
  assert.equal(big.peak, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].code, "equity:new-high");
  assert.equal(state.peak, 10_100);

  // Direkt danach: kein zweiter Alarm auf demselben Niveau.
  await checkEquityAlerts({ equity: 10_100, drawdownPct: 0, emit, state });
  assert.equal(sent.length, 1);
});

test("Drawdown-Schwellen sind ratchet-artig und setzen sich am neuen Hoch zurück", async () => {
  const { sent, emit } = collector();
  const state: EquityAlertState = { peak: 10_000, threshold: 0 };

  await checkEquityAlerts({ equity: 9_400, drawdownPct: 6, emit, state });
  assert.deepEqual(sent.map((s) => s.code), ["equity:drawdown-5"]);
  assert.equal(state.threshold, 5);

  // 7 % liegt über der bereits gemeldeten 5-%-Schwelle → kein neuer Alarm.
  await checkEquityAlerts({ equity: 9_300, drawdownPct: 7, emit, state });
  assert.equal(sent.length, 1);

  // 11 % überspringt 10 und meldet diese (nicht 5 erneut).
  await checkEquityAlerts({ equity: 8_900, drawdownPct: 11, emit, state });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].code, "equity:drawdown-10");
  assert.equal(sent[1].severity, "warning");
  assert.equal(state.threshold, 10);

  // Erholung unter die Schwelle setzt sie zurück …
  await checkEquityAlerts({ equity: 9_900, drawdownPct: 1, emit, state });
  assert.equal(state.threshold, 0);
  // … damit der nächste 5-%-Rückgang wieder meldet.
  await checkEquityAlerts({ equity: 9_400, drawdownPct: 6, emit, state });
  assert.equal(sent.length, 3);
  assert.equal(sent[2].code, "equity:drawdown-5");

  // Ein neues Hoch (hier +2 %) setzt die Schwellen ebenfalls zurück.
  await checkEquityAlerts({ equity: 10_400, drawdownPct: 0, emit, state });
  assert.equal(state.threshold, 0);
});

test("Alarm-Fehler brechen den Aufruf nicht, werden aber gemeldet", async () => {
  const errors: string[] = [];
  const state: EquityAlertState = { peak: 10_000, threshold: 0 };
  const emit = (async () => {
    throw new Error("Webhook tot");
  }) as unknown as Parameters<typeof checkEquityAlerts>[0]["emit"];

  const result = await checkEquityAlerts({ equity: 9_000, drawdownPct: 10, emit, state, errors });
  assert.equal(result.threshold, 10);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Alert equity:drawdown-10: Webhook tot/);
});

test("Schwellen-Liste aus der Umgebung, ungültige Kurse werden ignoriert", async () => {
  const previous = process.env[EQUITY_ALERT_ENV.THRESHOLDS_PCT];
  process.env[EQUITY_ALERT_ENV.THRESHOLDS_PCT] = "7";
  try {
    const { sent, emit } = collector();
    const state: EquityAlertState = { peak: 10_000, threshold: 0 };
    await checkEquityAlerts({ equity: 9_500, drawdownPct: 5, emit, state });
    assert.equal(sent.length, 0, "5 % ist mit Schwelle 7 nicht relevant");
    await checkEquityAlerts({ equity: 9_200, drawdownPct: 8, emit, state });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].code, "equity:drawdown-7");
  } finally {
    if (previous === undefined) delete process.env[EQUITY_ALERT_ENV.THRESHOLDS_PCT];
    else process.env[EQUITY_ALERT_ENV.THRESHOLDS_PCT] = previous;
  }

  // Ungültiger Kontostand (NaN/0) → kein Alarm, kein Zustandswechsel.
  const { sent, emit } = collector();
  const state: EquityAlertState = { peak: 10_000, threshold: 0 };
  const result = await checkEquityAlerts({ equity: Number.NaN, drawdownPct: 50, emit, state });
  assert.deepEqual(result, { peak: false, threshold: null });
  assert.equal(sent.length, 0);
});
