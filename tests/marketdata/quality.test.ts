/**
 * Qualitäts-Layer (GAP-07, v1.47.0) — D1/D2/D4.
 *
 * Pflichtfälle des Tickets:
 *  - GAP an erwarteter Position (Intervallgrenzen exakt: Abstand = Intervall
 *    ⇒ KEIN Befund; größer ⇒ Befund an der ersten fehlenden Position).
 *  - INVALID (high < low, OHLC ≤ 0, close außerhalb [low, high]);
 *    strict-Modus ⇒ DATA_UNAVAILABLE-Fallback greift; log-Modus schreibt
 *    nur den Report.
 *  - Outlier: künstlicher Wick jenseits der Schwelle wird markiert; ein
 *    realistischer Flash-Move UNTERHALB der Schwelle NICHT (Grenzwert-Test:
 *    genau mult × Baseline ⇒ kein Befund — echte Flash-Moves kommen durch).
 *  - DUPLICATE (ts doppelt).
 *  - Stale-Guard: Fake-Clock über Schwelle ⇒ stale.
 *  - Keine Mutation der Eingabeserie (Objekt-Freeze-Vergleich).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  buildQualityReport,
  crosscheckCandles,
  evaluateStaleSeries,
  isQualityClass,
  loadQualityConfig,
  loadQualityReport,
  parseOnFlag,
  parseQualityMode,
  qualityStrictDataErrors,
  qualityStrictDataErrorsForScan,
  recordQualityFindings,
  saveQualityReport,
  summarizeStaleByVenue,
  validateCandleSeries,
  type QualityCandle,
  type QualityReport,
  type QualitySeriesReport,
} from "../../src/marketdata/quality";
import { syncErrorsToDataErrors } from "../../src/marketdata/dataErrors";
import { SUPPORTED_TIMEFRAME_MS } from "../../src/lib/marketdata/historicalStore";
import {
  resetTelemetryForTests,
  telemetry,
} from "../../src/lib/telemetry";
import { mockMarketDataAdapter, syncHarness, tempDir, instrumentOf } from "./fixtures";
import type { MarketDataAdapter } from "../../src/marketdata";

const H = 3_600_000;
const DAY = 24 * H;
/** Stündliches Raster auf UTC-Mitternacht verankt (2026-01-01T00:00:00Z). */
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Ruhige 1h-Kerze mit konstanter True-Range 0.7 (Open=Close-Vorgänger). */
function calm(ts: number, close = 100.4): QualityCandle {
  return { time: ts, open: 100, high: 100.5, low: 99.8, close, volume: 10 };
}

/** `n` ruhige stündliche Kerzen ab `start` (konstante TR 0.7). */
function calmSeries(n: number, start: number = T0): QualityCandle[] {
  return Array.from({ length: n }, (_, i) => calm(start + i * H));
}

const INTERVAL = SUPPORTED_TIMEFRAME_MS["1h"];

// ── D1: GAP ──────────────────────────────────────────────────────────────────

test("GAP: fehlende Kerze wird an der erwarteten Position erkannt", () => {
  const series = [calm(T0), calm(T0 + H), calm(T0 + 3 * H)]; // 02:00 fehlt
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL });

  assert.equal(report.counts.GAP, 1, "genau eine Lücke");
  assert.equal(report.findings[0].cls, "GAP");
  assert.equal(report.findings[0].ts, T0 + 2 * H, "Befund am ersten fehlenden Intervall (02:00)");
  assert.match(report.findings[0].detail, /1 fehlend/);
  // Alles andere bleibt sauber.
  assert.equal(report.counts.INVALID, 0);
  assert.equal(report.counts.DUPLICATE, 0);
  assert.equal(report.counts.OUTLIER, 0);
});

test("GAP: exakt ein Intervall Abstand ist KEIN Befund (Grenze exakt)", () => {
  const series = [calm(T0), calm(T0 + H), calm(T0 + 2 * H)];
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL });
  assert.equal(report.counts.GAP, 0, "dichtes Raster ⇒ keine Lücke");
  assert.equal(report.findings.length, 0);
});

test("GAP: zwei fehlende Kerzen ergeben EINE Lücke mit Anzahl (2 fehlend)", () => {
  const series = [calm(T0), calm(T0 + 3 * H)];
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL });
  assert.equal(report.counts.GAP, 1);
  assert.equal(report.findings[0].ts, T0 + H, "erste fehlende Position");
  assert.match(report.findings[0].detail, /2 fehlend/);
});

// ── D1: INVALID ──────────────────────────────────────────────────────────────

test("INVALID: high < low wird erkannt", () => {
  const series = [calm(T0), { time: T0 + H, open: 100, high: 99, low: 101, close: 100, volume: 10 }];
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL });
  assert.equal(report.counts.INVALID, 1);
  assert.equal(report.findings[0].cls, "INVALID");
  assert.match(report.findings[0].detail, /high < low/);
});

test("INVALID: OHLC ≤ 0 wird erkannt (open = 0)", () => {
  const series = [calm(T0), { time: T0 + H, open: 0, high: 101, low: 99, close: 100, volume: 10 }];
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL });
  assert.equal(report.counts.INVALID, 1);
  assert.match(report.findings[0].detail, /≤ 0/);
});

test("INVALID: close außerhalb [low, high] wird erkannt", () => {
  const series = [calm(T0), { time: T0 + H, open: 100, high: 101, low: 99, close: 102, volume: 10 }];
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL });
  assert.equal(report.counts.INVALID, 1);
  assert.match(report.findings[0].detail, /close außerhalb \[low, high\]/);
});

test("INVALID-Kerze vergiftet die Outlier-Baseline nicht (extremer Range)", () => {
  // 19 ruhige Kerzen + eine INVALID-Kerze (high < low) mit extremem Range.
  // Wäre sie in der Baseline, hätte sie die Schwelle aufgeblasen oder selbst
  // als Outlier gegolten — beides muss ausbleiben.
  const series = calmSeries(19);
  series.push({ time: T0 + 19 * H, open: 100, high: 1, low: 9999, close: 100, volume: 10 });
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL, outlierAtrMult: 25 });
  assert.equal(report.counts.INVALID, 1, "die inkonsistente Kerze ist INVALID");
  assert.equal(report.counts.OUTLIER, 0, "extremer Range erzeugt keinen Outlier-Befund");
});

test("INVALID-Kerze erzeugt die erwartete (konservative) GAP-Betrachtung", () => {
  // Die INVALID-Kerze ist für die Gap-Logik nicht nutzbar — die Lücke zu ihr
  // wird also SEHEN: konservativ korrekt (verwendbare Daten sind in der Tat
  // an dieser Position nicht vorhanden).
  const series = [
    calm(T0),
    { time: T0 + H, open: 100, high: 90, low: 110, close: 100, volume: 10 },
    calm(T0 + 2 * H),
  ];
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL });
  assert.equal(report.counts.INVALID, 1);
  assert.equal(report.counts.GAP, 1, "Lücke an der Position der unbrauchbaren Kerze");
  assert.equal(report.findings.find((f) => f.cls === "GAP")!.ts, T0 + H);
});

// ── D1: DUPLICATE ────────────────────────────────────────────────────────────

test("DUPLICATE: doppelter Zeitstempel wird erkannt (2× ⇒ 1 Befund, 3× ⇒ 2 Befunde)", () => {
  const two = [calm(T0), calm(T0 + H), calm(T0 + H)];
  const r2 = validateCandleSeries(two, { expectedIntervalMs: INTERVAL });
  assert.equal(r2.counts.DUPLICATE, 1);
  assert.equal(r2.findings[0].cls, "DUPLICATE");
  assert.equal(r2.findings[0].ts, T0 + H);
  // Duplikat erzeugt keinen GAP.
  assert.equal(r2.counts.GAP, 0);

  const three = [calm(T0), calm(T0 + H), calm(T0 + H), calm(T0 + H)];
  const r3 = validateCandleSeries(three, { expectedIntervalMs: INTERVAL });
  assert.equal(r3.counts.DUPLICATE, 2, "jede weitere Vorkommnis zählt");
});

// ── D1: OUTLIER + Flash-Move-Schutz ──────────────────────────────────────────

test("OUTLIER: künstlicher Wick jenseits der Schwelle wird markiert", () => {
  // 20 ruhige Kerzen (konstante TR 0.7) + letzter mit Wick 20.1 > 25 × 0.7 = 17.5.
  const series = calmSeries(19);
  series.push({ time: T0 + 19 * H, open: 100, high: 120.5, low: 99.8, close: 100.4, volume: 10 });
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL, outlierAtrMult: 25 });

  assert.equal(report.counts.OUTLIER, 1, `erwartet 1 Outlier, Report: ${JSON.stringify(report.findings)}`);
  const f = report.findings.find((x) => x.cls === "OUTLIER")!;
  assert.equal(f.ts, T0 + 19 * H);
  assert.match(f.detail, /Wick/);
  // Der Outlier selbst bläht seine eigene Schwelle nicht auf (leave-one-out):
  // Baseline bleibt exakt 0.7 → Schwelle exakt 17.5.
  assert.match(f.detail, /17\.5000/);
});

test("OUTLIER: Grenzwert exakt mult × Baseline erzeugt KEINEN Befund", () => {
  const series = calmSeries(19);
  // Wick exakt 17.5 (= 25 × 0.7): high = max(open, close) + 17.5 = 117.9.
  series.push({ time: T0 + 19 * H, open: 100, high: 117.9, low: 99.8, close: 100.4, volume: 10 });
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL, outlierAtrMult: 25 });
  assert.equal(report.counts.OUTLIER, 0, "Genauigkeit: gleich groß ⇒ kein Befund (striktes >)");
});

test("OUTLIER: realistischer Flash-Move (10 %) UNTERHALB der Schwelle bleibt erhalten", () => {
  const series = calmSeries(19);
  // Flash-Crash: Close -10 % in einer Kerze — der Körper (10) bleibt unter
  // der Schwelle (25 × ~0.7 = 17.5). Wegfiltern wäre der eigentliche Fehler.
  series.push({ time: T0 + 19 * H, open: 100, high: 100.5, low: 89.9, close: 90, volume: 500 });
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL, outlierAtrMult: 25 });
  assert.equal(report.counts.OUTLIER, 0, "echter Flash-Move darf nicht weggefiltert werden");
});

test("OUTLIER: zu kurze Serie (1 Kerze) ⇒ kein Check, kein Crash", () => {
  const report = validateCandleSeries([calm(T0)], { expectedIntervalMs: INTERVAL });
  assert.equal(report.counts.OUTLIER, 0);
  assert.equal(report.findings.length, 0);
});

test("OUTLIER: konfigurierbare Schwelle (mult 5) markiert den 10 %-Bewegung", () => {
  const series = calmSeries(19);
  series.push({ time: T0 + 19 * H, open: 100, high: 100.5, low: 89.9, close: 90, volume: 500 });
  const report = validateCandleSeries(series, { expectedIntervalMs: INTERVAL, outlierAtrMult: 5 });
  assert.equal(report.counts.OUTLIER, 1, "Körper 10 > 5 × 0.7 = 3.5 ⇒ Befund bei enger Schwelle");
});

// ── D1: Determinismus + Immutabilität ────────────────────────────────────────

test("Determinismus: zweiter Lauf über dieselbe Eingabe ⇒ byte-identischer Report", () => {
  const mk = (): QualityCandle[] => [
    calm(T0),
    calm(T0 + H),
    { time: T0 + 3 * H, open: 100, high: 120.5, low: 99.8, close: 100.4, volume: 10 },
    calm(T0 + 4 * H),
    { time: T0 + 4 * H, open: 100, high: 100.5, low: 99.8, close: 100.4, volume: 10 },
  ];
  const a = validateCandleSeries(mk(), { expectedIntervalMs: INTERVAL });
  const b = validateCandleSeries(mk(), { expectedIntervalMs: INTERVAL });
  assert.equal(JSON.stringify(a), JSON.stringify(b), "byte-identisch");
});

test("Immutabilität: gefrorene Eingabeserie bleibt unangetastet (Freeze-Vergleich)", () => {
  const series: QualityCandle[] = [
    calm(T0),
    calm(T0 + H),
    { time: T0 + 3 * H, open: 100, high: 120.5, low: 99.8, close: 100.4, volume: 10 },
    { time: T0 + 3 * H, open: 100, high: 100.5, low: 99.8, close: 100.4, volume: 10 },
  ];
  for (const c of series) Object.freeze(c);
  Object.freeze(series);
  // Object.freeze wirft im Strict-Mode bei jedem Schreibversuch — läuft die
  // Validierung ohne Fehler durch, wurde nichts mutiert.
  assert.doesNotThrow(() => validateCandleSeries(series, { expectedIntervalMs: INTERVAL }));
  assert.deepEqual(series[0], { time: T0, open: 100, high: 100.5, low: 99.8, close: 100.4, volume: 10 });
});

// ── D1: Report-Persistenz + Modi ─────────────────────────────────────────────

function seriesWith(instrumentId: string, report: QualitySeriesReport): QualitySeriesReport {
  return { ...report, instrumentId, timeframe: "1h" };
}

test("Report: speichern + laden (atomar, 0600) — log-Modus schreibt nur den Report", () => {
  const dir = tempDir("mdq-");
  const file = path.join(dir, "quality-report.json");
  const raw = validateCandleSeries([calm(T0), calm(T0 + 3 * H)], { expectedIntervalMs: INTERVAL });
  const report = buildQualityReport(
    [seriesWith("BITUNIX:BTCUSDT", { ...raw, crosscheckCompared: 2 })],
    "log",
    new Date("2026-01-02T00:00:00Z"),
  );
  assert.equal(report.totals.byClass.GAP, 1);

  saveQualityReport(report, file);
  assert.ok(existsSync(file), "Report-Datei existiert");
  const loaded = loadQualityReport(file);
  assert.ok(loaded, "Report ist lesbar");
  assert.equal(loaded!.series.length, 1);
  assert.equal(loaded!.series[0].instrumentId, "BITUNIX:BTCUSDT");
  assert.equal(loaded!.series[0].counts.GAP, 1);
  assert.equal(loaded!.series[0].crosscheckCompared, 2, "Cross-Check-Coverage bleibt erhalten");
  assert.equal(loaded!.totals.series, 1);
  assert.equal(loaded!.totals.candles, 2);
  assert.equal(loaded!.totals.byClass.GAP, 1, "Aggregate werden aus validierten Reihen rekonstruiert");
  assert.equal(loaded!.mode, "log");
  // Roh-JSON ist deterministisch sortiert und stabil.
  const rawJson = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(rawJson.series[0].findings[0].cls, "GAP");
});

test("Report: fehlende/korrupte Datei ⇒ null (nie ein Wurf)", () => {
  const dir = tempDir("mdq-");
  const missing = path.join(dir, "nope.json");
  assert.equal(loadQualityReport(missing), null);
  const corrupt = path.join(dir, "corrupt.json");
  writeFileSync(corrupt, "{kaputt");
  assert.equal(loadQualityReport(corrupt), null);
});

test("strict-Modus: INVALID-Befund ⇒ DATA_UNAVAILABLE-Fallback (fail-closed)", () => {
  const invalid = validateCandleSeries(
    [calm(T0), { time: T0 + H, open: 100, high: 99, low: 101, close: 100, volume: 10 }],
    { expectedIntervalMs: INTERVAL },
  );
  const onlyGaps = validateCandleSeries([calm(T0), calm(T0 + 3 * H)], { expectedIntervalMs: INTERVAL });
  const report = buildQualityReport(
    [
      seriesWith("BITUNIX:BTCUSDT", invalid),
      seriesWith("BITUNIX:ETHUSDT", onlyGaps),
    ],
    "strict",
  );

  const strictMap = qualityStrictDataErrors(report, "strict");
  assert.equal(strictMap.get("BITUNIX:BTCUSDT"), "DATA_UNAVAILABLE", "INVALID ⇒ Unverfügbarkeit");
  assert.equal(strictMap.has("BITUNIX:ETHUSDT"), false, "nur GAP ⇒ Instrument bleibt lesbar");

  // log-Modus: gleiche Befunde, keine Wirkung (leere Map).
  assert.equal(qualityStrictDataErrors(report, "log").size, 0);
  assert.equal(qualityStrictDataErrors(null, "strict").size, 0, "ohne Report: leer");
});

test("qualityStrictDataErrorsForScan: log-Modus (Default) und leerer Env ⇒ leere Map", () => {
  assert.equal(qualityStrictDataErrorsForScan({}).size, 0);
  assert.equal(qualityStrictDataErrorsForScan({ MARKETDATA_QUALITY_MODE: "log" }).size, 0);
  // unknown Mode → fail-loud auf log (siehe Config-Test) ⇒ ebenfalls leer.
  assert.equal(qualityStrictDataErrorsForScan({ MARKETDATA_QUALITY_MODE: "streng" }).size, 0);
});

// ── D2: Stale-Guard ──────────────────────────────────────────────────────────

test("Stale-Guard: Fake-Clock über Schwelle ⇒ stale, darunter ⇒ frisch", () => {
  const now = Date.UTC(2026, 0, 10, 0, 0, 0);
  const cfg = loadQualityConfig({});
  const entries = [
    { instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h", ts: now - 27 * 3_600_000 }, // > 26 h
    { instrumentId: "BITUNIX:ETHUSDT", timeframe: "1h", ts: now - 25 * 3_600_000 }, // < 26 h
    { instrumentId: "BITUNIX:SOLUSDT", timeframe: "4h", ts: now - 105 * 3_600_000 }, // > 104 h
    // jüngste Kerze gewinnt (ältere Einträge derselben Reihe sind irrelevant):
    { instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h", ts: now - 27 * 3_600_000 - DAY },
  ];
  const states = evaluateStaleSeries(entries, cfg.staleHours, now);
  const byId = new Map(states.map((s) => [s.instrumentId, s]));
  assert.equal(byId.get("BITUNIX:BTCUSDT")!.stale, true, "27 h > 26 h ⇒ stale");
  assert.equal(byId.get("BITUNIX:ETHUSDT")!.stale, false, "25 h < 26 h ⇒ frisch");
  assert.equal(byId.get("BITUNIX:SOLUSDT")!.stale, true, "105 h > 104 h (4h-Default) ⇒ stale");
  // Deterministische Reihenfolge.
  assert.deepEqual(
    states.map((s) => s.instrumentId),
    [...states.map((s) => s.instrumentId)].sort((a, b) => a.localeCompare(b)),
  );
});

test("Stale-Guard: konfigurierbare Schwellen (MARKETDATA_STALE_1H_HOURS)", () => {
  const now = Date.UTC(2026, 0, 10, 0, 0, 0);
  const cfg = loadQualityConfig({ MARKETDATA_STALE_1H_HOURS: "48" });
  const entries = [{ instrumentId: "V:X", timeframe: "1h", ts: now - 40 * 3_600_000 }];
  const states = evaluateStaleSeries(entries, cfg.staleHours, now);
  assert.equal(states[0].stale, false, "40 h < 48 h (konfiguriert) ⇒ frisch");
});

test("Stale-Guard: Venue-Zusammenfassung liefert nur Zähler (kein Symbol)", () => {
  const now = Date.UTC(2026, 0, 10, 0, 0, 0);
  const cfg = loadQualityConfig({});
  const entries = [
    { instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h", ts: now - 30 * 3_600_000 },
    { instrumentId: "BITUNIX:ETHUSDT", timeframe: "1h", ts: now - 1 * 3_600_000 },
    { instrumentId: "BINANCE:BTCUSDT", timeframe: "1h", ts: now - 30 * 3_600_000 },
  ];
  const byVenue = summarizeStaleByVenue(entries, cfg.staleHours, now);
  assert.equal(byVenue.get("BITUNIX")!.totalSeries, 2);
  assert.equal(byVenue.get("BITUNIX")!.staleSeries, 1);
  assert.deepEqual(byVenue.get("BITUNIX")!.staleByTimeframe, { "1h": 1 });
  assert.equal(byVenue.get("BINANCE")!.staleSeries, 1);
  // Nur Zähler: keine Symbol-/Instrument-Strings in der Zusammenfassung.
  const json = JSON.stringify([...byVenue.values()]);
  assert.ok(!json.includes("BTCUSDT"), "keine Symbole in der Venue-Zusammenfassung");
});

// ── D4: Zweitquellen-Cross-Check (reine Funktion) ────────────────────────────

test("Cross-Check: Abweichung > Toleranz ⇒ CROSSCHECK-Befund", () => {
  const primary = [calm(T0, 100), calm(T0 + H, 100)];
  const secondary = [
    { time: T0, open: 100, high: 100.5, low: 99.8, close: 100, volume: 10 },
    { time: T0 + H, open: 100, high: 101.5, low: 99.8, close: 101.2, volume: 10 }, // +1.2 %
  ];
  const res = crosscheckCandles(primary, secondary, 1);
  assert.equal(res.compared, 2);
  assert.ok(res.finding, "1.2 % > 1 % ⇒ Befund");
  assert.equal(res.finding!.cls, "CROSSCHECK");
  assert.equal(res.finding!.ts, T0 + H);
  assert.match(res.finding!.detail, /1\.200 %/);
});

test("Cross-Check: Abweichung exakt Toleranz ⇒ KEIN Befund (striktes >)", () => {
  const primary = [calm(T0, 100)];
  const secondary = [{ time: T0, open: 100, high: 101, low: 99, close: 101, volume: 10 }]; // exakt +1.0 %
  const res = crosscheckCandles(primary, secondary, 1);
  assert.equal(res.finding, null);
  assert.ok(Math.abs(res.maxDeviationPct - 1) < 1e-9);
});

test("Cross-Check: keine Zeitstempel-Überlappung ⇒ 0 verglichen, kein Befund", () => {
  const primary = [calm(T0)];
  const secondary = [{ time: T0 + 7 * H, open: 100, high: 100, low: 100, close: 100, volume: 1 }];
  const res = crosscheckCandles(primary, secondary, 1);
  assert.equal(res.compared, 0);
  assert.equal(res.finding, null, "kein Vergleich möglich ≠ Abweichung");
});

// ── Konfiguration (Bounds + Defaults) ────────────────────────────────────────

test("Config: Defaults (log, off, 25, 1 %)", () => {
  const cfg = loadQualityConfig({});
  assert.equal(cfg.mode, "log");
  assert.equal(cfg.crosscheck, false);
  assert.equal(cfg.outlierAtrMult, 25);
  assert.equal(cfg.crosscheckTolerancePct, 1);
  assert.equal(cfg.staleHours["1h"], 26);
  assert.equal(cfg.staleHours["4h"], 104);
  assert.equal(cfg.staleHours["1d"], 624);
});

test("Config: Bounds-Clamp (mult [5,200], Toleranz [0.1,10], Stale 1h [2,168])", () => {
  const warnings: string[] = [];
  const cfg = loadQualityConfig(
    {
      MARKETDATA_OUTLIER_ATR_MULT: "300",
      MARKETDATA_CROSSCHECK_TOLERANCE_PCT: "50",
      MARKETDATA_STALE_1H_HOURS: "1",
      MARKETDATA_STALE_4H_HOURS: "1",
      MARKETDATA_STALE_1D_HOURS: "999999",
    },
    {},
    (w) => warnings.push(w),
  );
  assert.equal(cfg.outlierAtrMult, 200, "300 ⇒ 200 (Obergrenze)");
  assert.equal(cfg.crosscheckTolerancePct, 10, "50 ⇒ 10");
  assert.equal(cfg.staleHours["1h"], 2, "1 ⇒ 2 (Untergrenze)");
  assert.equal(cfg.staleHours["4h"], 8, "4h-Untergrenze");
  assert.equal(cfg.staleHours["1d"], 4032, "1d-Obergrenze");
  assert.ok(warnings.length >= 3, "Clamps werden laut gemeldet");
});

test("Config: kaputte Werte ⇒ Defaults + Warnung (nie ein Wurf)", () => {
  const warnings: string[] = [];
  const cfg = loadQualityConfig(
    {
      MARKETDATA_QUALITY_MODE: "streng",
      MARKETDATA_OUTLIER_ATR_MULT: "abc",
      MARKETDATA_CROSSCHECK: "ja",
    },
    {},
    (w) => warnings.push(w),
  );
  assert.equal(cfg.mode, "log", "unbekannter Modus ⇒ log (fail-loud)");
  assert.equal(cfg.outlierAtrMult, 25);
  assert.equal(cfg.crosscheck, false, "\"ja\" ist kein ON-Wert");
  assert.ok(warnings.some((w) => w.includes("MARKETDATA_QUALITY_MODE")));
  assert.ok(warnings.some((w) => w.includes("MARKETDATA_OUTLIER_ATR_MULT")));
});

test("parseOnFlag/parseQualityMode: geschlossene Grammatik", () => {
  assert.equal(parseOnFlag("on"), true);
  assert.equal(parseOnFlag("true"), true);
  assert.equal(parseOnFlag("1"), true);
  assert.equal(parseOnFlag("off"), false);
  assert.equal(parseOnFlag("maybe"), false);
  assert.equal(parseOnFlag(undefined), false);
  assert.equal(parseQualityMode("STRICT"), "strict", "case-insensitiv");
  assert.equal(parseQualityMode("log"), "log");
  assert.equal(parseQualityMode(undefined), "log");
  assert.equal(parseQualityMode("x"), "log");
  assert.ok(QUALITY_CLASSES_SANITY(), "geschlossene Klassen-Aufzählung");
});

function QUALITY_CLASSES_SANITY(): boolean {
  for (const cls of ["GAP", "OUTLIER", "INVALID", "DUPLICATE", "CROSSCHECK"] as const) {
    if (!isQualityClass(cls)) return false;
  }
  return !isQualityClass("SOMETHING_ELSE");
}

// ── Metrik (telemetry-Counter je Klasse) ─────────────────────────────────────

test("Metrik: recordQualityFindings zählt je Klasse in market_data_quality_findings_total", () => {
  resetTelemetryForTests();
  const report = buildQualityReport(
    [
      seriesWith("V:A", validateCandleSeries([calm(T0), calm(T0 + 3 * H)], { expectedIntervalMs: INTERVAL })),
      seriesWith("V:B", validateCandleSeries([calm(T0), { time: T0 + H, open: 0, high: 1, low: 0, close: 0, volume: 1 }], { expectedIntervalMs: INTERVAL })),
    ],
    "log",
  );
  recordQualityFindings(report);
  const byClass = telemetry.marketData.qualityFindings.byDimension("class");
  assert.equal(byClass.GAP, 1);
  assert.equal(byClass.INVALID, 1);
  assert.equal(telemetry.marketData.qualityFindings.total(), 2);
  resetTelemetryForTests();
});

// ── Schreibpfad: Verdrahtung im Sync (Log-Modus) ─────────────────────────────

test("Sync (log-Modus): Befunde landen im Sync-Report + Metrik, NICHT im Fetch-Manifest", async () => {
  resetTelemetryForTests();
  const t = T0;
  // Stündliche Rasterkerzen, aber 02:00 fehlt (GAP) und 03:00 ist invalid.
  const candles = [
    calm(t),
    calm(t + H),
    { time: t + 3 * H, open: 100, high: 99, low: 101, close: 100, volume: 10 },
    calm(t + 4 * H),
  ];
  const { adapter } = mockMarketDataAdapter({
    instruments: [instrumentOf("BTCUSDT")],
    candlesFor: () => candles,
  });
  const { service } = syncHarness(adapter);
  const result = await service.syncVenue("BITUNIX");

  assert.ok(result.qualityReport, "SyncResult trägt den Qualitäts-Report");
  assert.equal(result.qualityReport!.totals.byClass.GAP, 1);
  assert.equal(result.qualityReport!.totals.byClass.INVALID, 1);
  // log-Modus: kein Degradieren durch Qualitätsbefunde, keine Failures.
  assert.equal(result.degraded, false, "log-Modus macht sichtbar, aber nicht strenger");
  assert.equal(result.failures.length, 0);
  // Fetch-Fehler-Manifest bleibt leer (QUALITY_* ist kein Fetch-Fehler).
  assert.equal(syncErrorsToDataErrors(result.failures).size, 0);
  // Metrik je Klasse.
  const byClass = telemetry.marketData.qualityFindings.byDimension("class");
  assert.equal(byClass.GAP, 1);
  assert.equal(byClass.INVALID, 1);
  resetTelemetryForTests();
});

test("Sync: QUALITY_*-Failures fließen nie ins Datenfehler-Manifest (log-Semantik)", () => {
  const errors = [
    {
      stage: "candles" as const,
      instrumentId: "BITUNIX:BTCUSDT",
      message: "quality",
      reason: "QUALITY_GAP" as const,
      retryable: false,
    },
    {
      stage: "candles" as const,
      instrumentId: "BITUNIX:ETHUSDT",
      message: "fetch",
      reason: "DATA_UNAVAILABLE" as const,
      retryable: false,
    },
  ];
  const map = syncErrorsToDataErrors(errors);
  assert.equal(map.has("BITUNIX:BTCUSDT"), false, "QUALITY_* bleibt aus dem Manifest heraus");
  assert.equal(map.get("BITUNIX:ETHUSDT"), "DATA_UNAVAILABLE", "echte Fetch-Fehler bleiben drin");
});

// ── D4: Cross-Check im Sync (opt-in, Adapter-Interface) ──────────────────────

test("Sync (Cross-Check on): Abweichung > Toleranz ⇒ CROSSCHECK-Befund im Report", async () => {
  const t = T0;
  const primary = [calm(t), calm(t + H, 100.4), calm(t + 2 * H, 100.4), calm(t + 3 * H, 100.4)];
  const secondary = primary.map((c, i) => ({
    ...c,
    // Zweite Kerze weicht +2 % ab (> 1 % Toleranz).
    close: i === 1 ? 102.4 : c.close,
  }));
  let crosscalls = 0;
  const { adapter } = mockMarketDataAdapter({
    instruments: [instrumentOf("BTCUSDT")],
    candlesFor: () => primary,
  });
  const extended: MarketDataAdapter = {
    ...adapter,
    getCrosscheckCandles: async () => {
      crosscalls += 1;
      return secondary;
    },
  };
  const { service } = syncHarness(extended, "BITUNIX", {
    crosscheck: true,
    crosscheckTolerancePct: 1,
  });
  const result = await service.syncVenue("BITUNIX");
  assert.equal(crosscalls, 1, "genau ein Zweitquellen-Request je Reihe");
  assert.ok(result.qualityReport, "Report vorhanden");
  assert.equal(result.qualityReport!.totals.byClass.CROSSCHECK, 1);
  assert.equal(
    result.qualityReport!.series[0].crosscheckCompared,
    4,
    "vergliche Zeitstempel sind dokumentiert",
  );
  assert.equal(result.degraded, false, "Cross-Check-Befund degradiert den Lauf nicht");
});

test("Sync (Cross-Check Default off): KEIN Zweitquellen-Request (Rate-Limit-Disziplin)", async () => {
  const t = T0;
  const primary = [calm(t), calm(t + H)];
  let crosscalls = 0;
  const { adapter } = mockMarketDataAdapter({
    instruments: [instrumentOf("BTCUSDT")],
    candlesFor: () => primary,
  });
  const extended: MarketDataAdapter = {
    ...adapter,
    getCrosscheckCandles: async () => {
      crosscalls += 1;
      return primary;
    },
  };
  const { service } = syncHarness(extended); // Cross-Check nicht aktiviert
  await service.syncVenue("BITUNIX");
  assert.equal(crosscalls, 0, "Default off ⇒ kein zusätzlicher Request");
});
