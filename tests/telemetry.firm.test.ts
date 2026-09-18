/**
 * GAP-10 (v1.45.0) — Firmen-Metriken in der Prometheus-Exposition (D1).
 *
 * Deckt die Abnahmekriterien aus
 * docs/audits/2026-09-18-feature-gap/findings/GAP-10-observability-circuit-breaker.md
 * ab:
 *
 *   - Snapshot enthält die Firmen-Metriken (Equity, Drawdown, offene
 *     Positionen, realisiertes Tages-P&L) plus die Counter (Fills/Rejects/
 *     LLM-Latenz).
 *   - Nicht lesbarer Firmenzustand (DB weg) → „degraded“-HELP-Kommentar,
 *     KEINE Exception, KEIN Hänger — und kein erfundener 0-Wert.
 *   - Keine Secrets im Output: Labels laufen über `metricLabel` (Whitelist),
 *     unbekannte Felder eines Firmenzustands werden ignoriert.
 *
 * Die Tests brauchen KEINE Datenbank: der Firmenzustand wird injiziert; der
 * Degradations-Pfad wird explizit über `firmState: null` geprüft.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  metricLabel,
  prometheusMetrics,
  resetTelemetryForTests,
  telemetry,
  type FirmMetricState,
} from "../src/lib/telemetry";
import { classifyRejectReason } from "../src/lib/broker";

const FIRM_STATE: FirmMetricState = {
  equity: 10432.5,
  startingEquity: 10000,
  drawdownPct: 0.0123,
  openPositions: 2,
  realizedPnlToday: -120.25,
  source: "paper-broker",
};

beforeEach(() => {
  resetTelemetryForTests();
});

test("D1: Exposition enthält Firmen-Metriken aus dem übergebenen Zustand", async () => {
  telemetry.firm.orderFills.inc({ kind: "OPEN", reason: "ORDER" });
  telemetry.firm.orderFills.inc({ kind: "CLOSE", reason: "STOP_LOSS" }, 2);
  telemetry.firm.orderRejects.inc({ reason: "INSUFFICIENT_CASH" });
  telemetry.firm.llmCalls.inc({ provider: "ollama", outcome: "ok" }, 3);
  telemetry.firm.llmLatencyMs.inc({ provider: "ollama" }, 1500);

  const text = await prometheusMetrics({ firmState: FIRM_STATE });

  // Firmen-Kennzahlen (Gauge-Werte, Prometheus-Textformat).
  assert.match(text, /^# HELP firm_equity /m);
  assert.match(text, /^firm_equity 10432\.5$/m);
  assert.match(text, /^firm_drawdown_pct 0\.0123$/m);
  assert.match(text, /^firm_open_positions 2$/m);
  assert.match(text, /^firm_realized_pnl_today -120\.25$/m);
  assert.match(text, /^firm_metric_source\{source="paper-broker"\} 1$/m);

  // Counter aus dem Order-/Routing-Pfad.
  assert.match(text, /^firm_order_fills_total\{kind="CLOSE",reason="STOP_LOSS"\} 2$/m);
  assert.match(text, /^firm_order_fills_total\{kind="OPEN",reason="ORDER"\} 1$/m);
  assert.match(text, /^firm_order_rejects_total\{reason="INSUFFICIENT_CASH"\} 1$/m);
  assert.match(text, /^llm_calls_total\{outcome="ok",provider="ollama"\} 3$/m);
  assert.match(text, /^llm_latency_ms_sum\{provider="ollama"\} 1500$/m);

  // Bestehende Marktdaten-/Audit-Counter bleiben enthalten (keine Regression).
  assert.match(text, /^market_data_fetch_failures_total /m);
  assert.match(text, /^audit_write_failures_total /m);
});

test("D1: nicht lesbarer Firmenzustand → degraded statt Exception, kein 0-Wert", async () => {
  const text = await prometheusMetrics({ firmState: null });

  // Metrik weggelassen (kein Sample) …
  assert.ok(!/^firm_equity /m.test(text), "kein Equity-Sample im degradierten Zustand");
  assert.ok(!/^firm_open_positions /m.test(text));
  // … aber der Grund ist maschinenlesbar sichtbar.
  assert.match(text, /^# HELP firm_equity .*degraded:/m);
  assert.match(text, /^# HELP firm_drawdown_pct .*degraded:/m);
  // Die (prozesslokalen) Counter bleiben vollständig lesbar.
  assert.match(text, /^market_data_fetch_failures_total /m);
});

test("D1: ohne Injektion wirft die Exposition nie (DB/Ledger nicht erreichbar)", async () => {
  // In der Testumgebung existiert weder ein hydratisierter Ledger noch eine DB:
  // Der Selbst-Lese-Pfad muss degradieren, nicht werfen und nicht hängen.
  const text = await prometheusMetrics();
  assert.equal(typeof text, "string");
  assert.match(text, /^audit_write_failures_total /m);
});

test("D1: unbekannte Felder/Secrets landen nicht in der Exposition", async () => {
  // Ein „Firmenzustand“ mit Zusatzfeldern: nur die explizit bekannten Zahlen
  // werden ausgegeben — ein Secret-Feld wird ignoriert.
  const withSecret = {
    ...FIRM_STATE,
    apiKey: "sk-live-SECRET-MARKER-1234567890",
    note: "https://hooks.example.test/services/T000/B000/XXXXXXXX",
  } as FirmMetricState;

  const text = await prometheusMetrics({ firmState: withSecret });
  assert.ok(!text.includes("SECRET-MARKER"));
  assert.ok(!text.includes("hooks.example.test"));
  assert.ok(!text.toLowerCase().includes("apikey"));
  assert.match(text, /^firm_equity 10432\.5$/m);
});

test("D1: metricLabel ist Whitelist-basiert (Kardinalität + Secret-Schutz)", () => {
  assert.equal(metricLabel("STOP_LOSS"), "STOP_LOSS");
  assert.equal(metricLabel("ollama"), "ollama");
  // Leerzeichen/Steuerzeichen/Sonderfälle → Fallback (keine Fremdtexte).
  assert.equal(metricLabel("sk-live SECRET"), "OTHER");
  assert.equal(metricLabel("a".repeat(41)), "OTHER");
  assert.equal(metricLabel(undefined, "unknown"), "unknown");
});

test("D1: Reject-Klassen im Order-Pfad tragen kein Symbol und keine Secrets", () => {
  // Der Broker reicht die Rohgründe (Symbol, Beträge) nie ins Label: nur die
  // Code-Klasse vor dem ersten `:`/Leerzeichen.
  assert.equal(classifyRejectReason("NO_QUOTE:SOL"), "NO_QUOTE");
  assert.equal(
    classifyRejectReason("INSUFFICIENT_CASH: benötigt 12.34 (inkl. Slippage), verfügbar 1.00"),
    "INSUFFICIENT_CASH",
  );
  assert.equal(
    classifyRejectReason("POSITION_ALREADY_OPEN:BTC (kein Nachkauf erlaubt)"),
    "POSITION_ALREADY_OPEN",
  );
  assert.equal(classifyRejectReason("BLOCKED by guardrail(s): position-size:max-25%-of-equity"), "GUARDRAIL");
  // Auch ein Secret im Rohgrund wird abgeschnitten — das Label bleibt die
  // Code-Klasse, nie der Fremdtext.
  const secretReason = classifyRejectReason("Bearer sk-live-SECRET-MARKER");
  assert.equal(secretReason, "BEARER");
  assert.ok(!secretReason.includes("SECRET"));
});
