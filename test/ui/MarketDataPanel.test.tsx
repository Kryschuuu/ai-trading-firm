/**
 * Render-Tests des MarketDataPanel (OPS-011) — die tatsächliche Komponente,
 * keine Nachbildung. `renderToStaticMarkup` beweist ohne Netz und Browser:
 *
 *  11  WARMING wird mit handlungsleitendem Hinweis gerendert
 *  12  READY beschuldigt die Market-Data-Schicht nicht
 *  13  der Funnel (Scanner-Sektion) bleibt in allen Zuständen sichtbar
 *  14  Accessibility: Ampelzustand ist textkodiert, nicht nur farbkodiert
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MarketDataPanel from "../../src/components/ops/MarketDataPanel";
import { OperationsCenterView } from "../../src/components/ops/OperationsCenterPanel";
import { buildOpsPayload } from "../../src/auth/ops";
import type { MarketDataOpsSnapshot, MarketDataReadinessStatus } from "../../src/ops/types";

const AT = "2026-08-31T12:00:00.000Z";

/** Deterministischer Snapshot je Ampelzustand. */
function snapshot(status: MarketDataReadinessStatus, overrides: Partial<MarketDataOpsSnapshot> = {}): MarketDataOpsSnapshot {
  const base: MarketDataOpsSnapshot = {
    generatedAt: AT,
    requiredCandles: 61,
    registry: 26,
    discovered: 26,
    dataReady: 0,
    warming: 26,
    tickerReady: 0,
    spreadReady: 0,
    scannerReady: false,
    readinessStatus: status,
    venues: [
      {
        venue: "BITUNIX",
        lastSyncAt: status === "WARMING" ? null : AT,
        lastSyncDegraded: status === "ERROR",
        instruments: 26,
        failuresByReason: status === "ERROR" ? { RATE_LIMITED: 12 } : {},
      },
    ],
    worstOffenders:
      status === "READY" ? [] : [{ instrumentId: "BITUNIX:BTCUSDT", candles: 0, required: 61 }],
    hint:
      status === "ERROR"
        ? "Market-Data-Abrufe schlagen fehl (haeufigste Ursache: RATE_LIMITED). Der leere Funnel ist ein Infrastrukturproblem, keine Marktbewertung. Naechster Schritt: Venue-Status und Request-Budget pruefen."
        : status === "WARMING"
          ? "Es liegt noch keine Kerzenhistorie vor. Fuehre npm run market:sync -- --venue=BITUNIX aus. Benoetigt werden 61 Kerzen je Instrument, weil der konfigurierte Faktorsatz eine EMA50 und einen Momentum-Lookback von 60 Perioden enthaelt."
          : "Datenbasis vollstaendig. Ein leerer Funnel ist hier eine echte fachliche Aussage: aktuell erfuellt kein Instrument die Eignungskriterien.",
    ...overrides,
  };
  if (status === "READY") {
    return {
      ...base,
      dataReady: base.registry,
      warming: 0,
      tickerReady: base.registry,
      spreadReady: base.registry,
      scannerReady: true,
      ...overrides,
    };
  }
  return base;
}

function renderPanel(s: MarketDataOpsSnapshot): string {
  return renderToStaticMarkup(createElement(MarketDataPanel, { snapshot: s }));
}

/** Vollständiger Ops-Payload mit Scanner-Sektion (Funnel) + Snapshot. */
function payloadWith(s: MarketDataOpsSnapshot) {
  return buildOpsPayload(
    null,
    {
      scanner: {
        id: "scanner",
        status: "empty",
        asOf: AT,
        metrics: [
          { label: "Gescannt", value: "26" },
          { label: "Eligible", value: "0" },
          { label: "Daily-Rotation", value: "0" },
        ],
        items: [],
        note: null,
        error: null,
      },
    },
    { marketData: s },
  );
}

test("panel renders WARMING state with actionable hint", () => {
  const html = renderPanel(snapshot("WARMING"));
  assert.match(html, /Market Data/);
  assert.match(html, /WARMING/);
  assert.match(html, /npm run market:sync -- --venue=BITUNIX/, "Hinweis muss handlungsleitend sein");
  assert.match(html, /61 Kerzen je Instrument/);
  assert.match(html, /Scanner-ready/);
  assert.match(html, /NO/);
  assert.match(html, /datenbedingt/, "Funnel-Nullen werden als datenbedingt erklärt");
  assert.match(html, /Worst offenders \(1\)/, "worst offenders ausklappbar vorhanden");
  assert.match(html, /BITUNIX:BTCUSDT/);
});

test("panel renders READY state and does not blame the market data layer", () => {
  const html = renderPanel(snapshot("READY"));
  assert.match(html, /READY/);
  assert.match(html, /YES/);
  assert.match(html, /echte fachliche Aussage/);
  assert.doesNotMatch(html, /Infrastrukturproblem/);
  assert.doesNotMatch(html, /schlagen fehl/);
  assert.doesNotMatch(html, /keine Kerzenhistorie/);
  assert.doesNotMatch(html, /datenbedingt/, "READY erklärt den Funnel nicht mit Datenproblemen");
});

test("panel renders ERROR state with infrastructure hint and failure counters", () => {
  const html = renderPanel(snapshot("ERROR"));
  assert.match(html, /ERROR/);
  assert.match(html, /Infrastrukturproblem, keine Marktbewertung/);
  assert.match(html, /RATE_LIMITED×12/, "Fehler-Counter nach reason sichtbar");
  assert.match(html, /degraded/);
});

test("funnel remains visible in all states", () => {
  for (const status of ["READY", "WARMING", "ERROR"] as const) {
    const html = renderToStaticMarkup(
      createElement(OperationsCenterView, {
        payload: payloadWith(snapshot(status)),
        loading: false,
        error: "",
      }),
    );
    assert.match(html, /Market Data/, `${status}: Market-Data-Sektion vorhanden`);
    // Der Funnel (Scanner-Sektion mit seinen Kennzahlen) bleibt unverändert erhalten:
    assert.match(html, /Gescannt/, `${status}: Funnel sichtbar`);
    assert.match(html, /Eligible/, `${status}: Funnel-Kennzahlen sichtbar`);
    assert.match(html, /Daily-Rotation/, `${status}: Funnel-Kennzahlen sichtbar`);
    // Market Data steht im Markup VOR dem Funnel (oberhalb, Ticket §2):
    assert.ok(
      html.indexOf("Market Data") < html.indexOf("Gescannt"),
      `${status}: Market-Data-Sektion steht oberhalb des Funnels`,
    );
  }
});

test("accessibility: traffic-light state is text-coded, not only color-coded", () => {
  for (const status of ["READY", "WARMING", "ERROR"] as const) {
    const html = renderPanel(snapshot(status));
    assert.match(html, /role="status"/, `${status}: Statuselement ist als role=status ausgezeichnet`);
    assert.ok(html.includes(status), `${status}: Zustand erscheint als Text (nicht nur Farbe)`);
    // Zusätzlich ein deutsches Klartext-Label neben dem Statuscode:
    const label = status === "READY" ? "bereit" : status === "WARMING" ? "Warmup" : "Fehler";
    assert.ok(html.includes(label), `${status}: deutsches Textlabel "${label}" vorhanden`);
  }
});
