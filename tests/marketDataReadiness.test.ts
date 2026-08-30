/**
 * Unit-Tests: Market-Data-Readiness-Report + Eligibility-Diagnose (OPS-010).
 *
 * Fixiert exakt die Review-Szenarien als Regressionstests:
 *   - Ist-Zustand: 26 Registry-Instrumente, 0 Kerzen → „Gescannt 26, Eligible 0“
 *     ist KEIN Scanner-Bug, sondern fehlende Historie (warmingCount 26).
 *   - Ziel-Zustand: 180 Instrumente nach erfolgreichem Sync → scannerReady.
 *   - Boundary: candleCount === requiredWarmupCandles() gilt als ready.
 *   - Diagnose: spread === null ⇒ „max-spread“ + vollständiger Datenzustand
 *     (Data-Quality statt fachlichem Markturteil).
 *
 * Alle Eingaben werden injiziert — kein Dateisystem, kein Netzwerk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildOpsPayload } from "../src/auth/ops";
import { loadScannerConfig, type ScannerConfig } from "../src/scanner/config";
import {
  buildEligibilityDiagnostics,
  MAX_ELIGIBILITY_DIAGNOSTICS,
} from "../src/scanner/eligibilityDiagnostics";
import type { FilterRejection } from "../src/scanner/filters";
import { scanUniverse } from "../src/scanner/pipeline";
import { requiredWarmupCandles } from "../src/scanner/warmup";
import {
  collectMarketDataReadiness,
  DISCOVERY_FRESHNESS_WINDOW_MS,
  MULTI_VENUE_LABEL,
  type MarketDataReadinessReport,
} from "../src/ops/marketDataReadiness";
import { OperationsCenterView } from "../src/components/ops/OperationsCenterPanel";
import { AS_OF, AS_OF_MS, candlesFromCloses, instrument } from "./fixtures/scannerFixtures";
import type { MarketInstrument } from "../src/universe/types";

const CONFIG: ScannerConfig = loadScannerConfig();
const REQUIRED = requiredWarmupCandles(CONFIG); // Default-Faktorsatz ⇒ 61
const NOW = AS_OF_MS;

/** Review-Ist-Zustand: BITUNIX-Instrumente ohne jede Enrichment/Backfill-Daten. */
function coldInstruments(count: number): MarketInstrument[] {
  return Array.from({ length: count }, (_, i) =>
    instrument({
      venue: "BITUNIX",
      symbol: `COLD${String(i).padStart(3, "0")}USDT`,
      marketType: "perpetual",
      volume24h: null,
      spread: null,
      volatility: null,
      lastSeen: new Date(NOW - 60_000).toISOString(), // frisch entdeckt, aber nicht enriched
    }),
  );
}

/** Review-Ziel-Zustand: vollständig gesyncte Instrumente (Kerzen + Ticker + Spread). */
function warmInstruments(count: number, candles: number): { instruments: MarketInstrument[]; candleCounts: Map<string, number> } {
  const instruments = Array.from({ length: count }, (_, i) =>
    instrument({
      venue: "BITUNIX",
      symbol: `WARM${String(i).padStart(3, "0")}USDT`,
      marketType: "perpetual",
      volume24h: 2_840_000_000,
      spread: 0.0002,
      lastSeen: new Date(NOW - 5 * 60_000).toISOString(),
    }),
  );
  const candleCounts = new Map(instruments.map((i) => [i.id, candles] as const));
  return { instruments, candleCounts };
}

// ─────────────────────────────────────────────────────────────────────────────
// collectMarketDataReadiness — Zähler
// ─────────────────────────────────────────────────────────────────────────────

test("leere Registry: alle Zähler 0, scannerReady false, Venue ALL", () => {
  const report = collectMarketDataReadiness({
    instruments: [],
    candleCounts: new Map(),
    config: CONFIG,
    now: NOW,
  });
  assert.deepEqual(report, {
    venue: MULTI_VENUE_LABEL,
    registryCount: 0,
    discoveredCount: 0,
    dataReadyCount: 0,
    warmingCount: 0,
    candlesLoaded: 0,
    candlesRequired: REQUIRED,
    tickerReadyCount: 0,
    spreadReadyCount: 0,
    scannerReady: false,
  } satisfies MarketDataReadinessReport);
});

test("Regression Review-Ist-Zustand: 26 Instrumente, 0 Kerzen → warming 26, scannerReady false", () => {
  const instruments = coldInstruments(26);
  const report = collectMarketDataReadiness({
    instruments,
    candleCounts: new Map(), // kein Sync gelaufen — Historical Store leer
    config: CONFIG,
    registrySize: instruments.length,
    now: NOW,
  });
  // Exakt der im Review gezeigte Block:
  //   Registry 26 / Discovered 26 / Data-ready 0 / Warming 26 /
  //   Candles 0/61 / Ticker-ready 0 / Spread-ready 0 / Scanner-ready NO
  assert.equal(report.venue, "BITUNIX");
  assert.equal(report.registryCount, 26);
  assert.equal(report.discoveredCount, 26);
  assert.equal(report.dataReadyCount, 0);
  assert.equal(report.warmingCount, 26);
  assert.equal(report.candlesLoaded, 0);
  assert.equal(report.candlesRequired, 61);
  assert.equal(report.tickerReadyCount, 0);
  assert.equal(report.spreadReadyCount, 0);
  assert.equal(report.scannerReady, false);
});

test("Ziel-Zustand nach erfolgreichem Sync: 180 Instrumente ready, Zähler aggregiert", () => {
  const { instruments, candleCounts } = warmInstruments(180, 150);
  const report = collectMarketDataReadiness({
    instruments,
    candleCounts,
    config: CONFIG,
    registrySize: instruments.length,
    now: NOW,
  });
  assert.equal(report.registryCount, 180);
  assert.equal(report.discoveredCount, 180);
  assert.equal(report.dataReadyCount, 180);
  assert.equal(report.warmingCount, 0);
  assert.equal(report.candlesLoaded, 180 * 150); // Summe geladener Kerzen
  assert.equal(report.candlesRequired, 61); // Referenzwert je Instrument
  assert.equal(report.tickerReadyCount, 180);
  assert.equal(report.spreadReadyCount, 180);
  assert.equal(report.scannerReady, true);
});

test("Boundary: candleCount exakt === requiredWarmupCandles gilt als ready (nicht warming)", () => {
  const ready = warmInstruments(1, REQUIRED);
  const boundaryReport = collectMarketDataReadiness({
    instruments: ready.instruments,
    candleCounts: ready.candleCounts,
    config: CONFIG,
    now: NOW,
  });
  assert.equal(boundaryReport.dataReadyCount, 1);
  assert.equal(boundaryReport.warmingCount, 0);
  assert.equal(boundaryReport.scannerReady, true);

  const short = warmInstruments(1, REQUIRED - 1); // eine Kerze zu wenig
  const belowReport = collectMarketDataReadiness({
    instruments: short.instruments,
    candleCounts: short.candleCounts,
    config: CONFIG,
    now: NOW,
  });
  assert.equal(belowReport.dataReadyCount, 0);
  assert.equal(belowReport.warmingCount, 1);
  assert.equal(belowReport.scannerReady, false);
});

test("Discovered nutzt das Frische-Fenster: altes lastSeen zählt nicht", () => {
  const fresh = coldInstruments(1)[0]; // lastSeen: jetzt − 1 min
  const stale = instrument({
    venue: "BITUNIX",
    symbol: "STALEUSDT",
    volume24h: null,
    spread: null,
    lastSeen: new Date(NOW - DISCOVERY_FRESHNESS_WINDOW_MS - 60_000).toISOString(),
  });
  const broken = instrument({
    venue: "BITUNIX",
    symbol: "BROKENUSDT",
    volume24h: null,
    spread: null,
    lastSeen: "kein-zeitstempel",
  });
  const report = collectMarketDataReadiness({
    instruments: [fresh, stale, broken],
    candleCounts: new Map(),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(report.registryCount, 3);
  assert.equal(report.discoveredCount, 1); // nur das frische
});

test("Registry-Metriken allein reichen nicht: Kerzen UND Ticker UND Spread nötig", () => {
  const { instruments, candleCounts } = warmInstruments(4, 150);
  instruments[0] = { ...instruments[0], volume24h: null }; // Enrichment fehlt
  instruments[1] = { ...instruments[1], spread: null }; // depth fehlt
  candleCounts.set(instruments[2].id, REQUIRED - 1); // Backfill unvollständig
  // instruments[3] vollständig
  const report = collectMarketDataReadiness({
    instruments,
    candleCounts,
    config: CONFIG,
    now: NOW,
  });
  assert.equal(report.dataReadyCount, 1);
  assert.equal(report.warmingCount, 3);
  assert.equal(report.tickerReadyCount, 3);
  assert.equal(report.spreadReadyCount, 3);
  assert.equal(report.scannerReady, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// buildEligibilityDiagnostics — Ablehnungs-Diagnose mit Datenzustand
// ─────────────────────────────────────────────────────────────────────────────

test("Diagnose bei spread === null: rule max-spread mit vollem Datenzustand (Review-Format)", () => {
  const target = instrument({
    venue: "BITUNIX",
    symbol: "BTCUSDT",
    marketType: "perpetual",
    volume24h: 2_840_000_000,
    spread: null, // Orderbook-Enrichment nie gelaufen
  });
  const candles = candlesFromCloses(Array.from({ length: 150 }, () => 100));
  const scan = scanUniverse({
    instruments: [target],
    data: { candles: () => candles },
    asOf: AS_OF,
    config: CONFIG,
  });

  // „Erste Regel gewinnt“-Routing bleibt unverändert: genau eine Ablehnung,
  // und zwar max-spread (min-candles und min-volume sind bestanden).
  assert.equal(scan.rejections.length, 1);
  assert.equal(scan.rejections[0].ruleId, "max-spread");
  assert.equal(scan.rejections[0].dataQuality, true);

  const diagnostics = buildEligibilityDiagnostics(scan.rejections, (instrumentId) => ({
    candles: instrumentId === target.id ? candles.length : 0,
    volume24h: target.volume24h,
    spread: target.spread,
  }));

  assert.equal(diagnostics.total, 1);
  assert.equal(diagnostics.truncated, false);
  // Exakt das Beispiel-Format aus dem Review Punkt 22:
  assert.deepEqual(diagnostics.items[0], {
    instrument: "BITUNIX:BTCUSDT",
    eligibility: {
      status: "rejected",
      rule: "max-spread",
      dataQuality: true,
      data: {
        candles: 150,
        volume24h: 2_840_000_000,
        spread: null,
      },
    },
  });
});

test("Diagnose unterscheidet Data-Quality von fachlicher Ablehnung", () => {
  const rejections: FilterRejection[] = [
    { instrumentId: "BITUNIX:AUSDT", ruleId: "max-spread", message: "nicht geladen", dataQuality: true },
    { instrumentId: "BITUNIX:BUSDT", ruleId: "min-volume", message: "zu klein", dataQuality: false },
  ];
  const diagnostics = buildEligibilityDiagnostics(rejections, (id) => ({
    candles: 150,
    volume24h: id.endsWith("BUSDT") ? 10 : null,
    spread: id.endsWith("AUSDT") ? null : 0.0002,
  }));
  assert.equal(diagnostics.items[0].eligibility.dataQuality, true);
  assert.equal(diagnostics.items[0].eligibility.data.spread, null);
  assert.equal(diagnostics.items[1].eligibility.dataQuality, false);
  assert.equal(diagnostics.items[1].eligibility.data.volume24h, 10);
});

test("Diagnose-Ausgabe ist gedeckelt (DoS): items ≤ Limit, total bleibt vollzählig", () => {
  assert.ok(MAX_ELIGIBILITY_DIAGNOSTICS > 0 && MAX_ELIGIBILITY_DIAGNOSTICS <= 100);
  const rejections: FilterRejection[] = Array.from({ length: 3 }, (_, i) => ({
    instrumentId: `BITUNIX:T${i}USDT`,
    ruleId: "min-candles",
    message: "fehlt",
    dataQuality: true,
  }));
  const limited = buildEligibilityDiagnostics(rejections, () => ({ candles: 0, volume24h: null, spread: null }), 2);
  assert.equal(limited.total, 3);
  assert.equal(limited.items.length, 2);
  assert.equal(limited.truncated, true);
  // Reihenfolge = Scan-Reihenfolge (deterministisch, keine Sortier-Überraschung)
  assert.deepEqual(limited.items.map((d) => d.instrument), ["BITUNIX:T0USDT", "BITUNIX:T1USDT"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ops-Payload: additive Erweiterung ohne Breaking Change
// ─────────────────────────────────────────────────────────────────────────────

test("buildOpsPayload: Extras additiv — ohne Extras bleibt das Format unverändert", () => {
  const plain = buildOpsPayload(null, {});
  assert.equal(plain.marketDataReadiness ?? null, null);
  assert.equal(plain.eligibilityDiagnostics ?? null, null);
  assert.ok(Array.isArray(plain.sections) && plain.sections.length === 10);

  const report = collectMarketDataReadiness({
    instruments: coldInstruments(26),
    candleCounts: new Map(),
    config: CONFIG,
    now: NOW,
  });
  const diagnostics = buildEligibilityDiagnostics([], () => ({ candles: 0, volume24h: null, spread: null }));
  const enriched = buildOpsPayload(null, {}, { marketDataReadiness: report, eligibilityDiagnostics: diagnostics });
  assert.equal(enriched.sections.length, 10);
  assert.deepEqual(enriched.marketDataReadiness, report);
  assert.equal(enriched.eligibilityDiagnostics?.total, 0);
  // JSON-Rundreise: nur plain data, keine Funktionen/Maps im Report
  const roundTripped = JSON.parse(JSON.stringify(enriched)) as typeof enriched;
  assert.equal(roundTripped.marketDataReadiness?.scannerReady, false);
  assert.equal(roundTripped.marketDataReadiness?.candlesRequired, 61);
});

test("UI rendert die Market-Data-Sektion im Review-Format inkl. Scanner-ready NO", () => {
  const report = collectMarketDataReadiness({
    instruments: coldInstruments(26),
    candleCounts: new Map(),
    config: CONFIG,
    registrySize: 26,
    now: NOW,
  });
  const diagnostics = buildEligibilityDiagnostics(
    [
      {
        instrumentId: "BITUNIX:COLD000USDT",
        ruleId: "min-candles",
        message: "fehlt",
        dataQuality: true,
      },
    ],
    () => ({ candles: 0, volume24h: null, spread: null }),
  );
  const payload = buildOpsPayload(null, {}, { marketDataReadiness: report, eligibilityDiagnostics: diagnostics });
  const html = renderToStaticMarkup(
    createElement(OperationsCenterView, { payload, loading: false, error: "" }),
  );
  for (const needle of [
    "Market Data",
    "Registry",
    "Discovered",
    "Data-ready",
    "Warming",
    "Candles",
    "Ticker-ready",
    "Spread-ready",
    "Scanner-ready",
    "NO",
    "0 / 61",
    "Ablehnungs-Diagnose",
    "nicht geladen",
    "requiredWarmupCandles()",
  ]) {
    assert.ok(html.includes(needle), `Market-Data-Karte ohne '${needle}'`);
  }
});
