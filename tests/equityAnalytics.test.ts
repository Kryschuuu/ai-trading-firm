/**
 * Tests der Equity-Kurven-Analytik (`src/lib/equityAnalytics.ts`).
 *
 * Schwerpunkt ist der Fehler, der den Drawdown im Dashboard „nicht berechnet“
 * aussehen ließ: Der Drawdown wurde aus der Summe der realisierten P&L
 * gerechnet (Peak ≤ 0 → nie ein Wert). Hier wird die Definition festgenagelt:
 * Rückgang vom **laufenden Höchststand**, Peak-to-Trough, mit dem
 * Referenz-Höchststand aus der Zeit VOR dem Fenster.
 *
 * Dazu kommen die Helfer, die Achse und Antwortgröße bestimmen: Bucket-Wahl,
 * Extremwert-erhaltendes Downsampling, „schöne“ Achsen-Ticks und die
 * Berliner Zeitachsen-Ticks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  benchmarkReturnPct,
  bucketsToPoints,
  computeEquityStats,
  buildTimeTicks,
  dailyReturns,
  downsamplePreservingExtremes,
  drawdownEpisodes,
  finalizeMonthlyReturns,
  formatAxisValue,
  formatMoney,
  formatPct,
  formatTimeTick,
  monthlyReturns,
  monthlySummary,
  niceLogTicks,
  niceTicks,
  scaleBenchmarkSeries,
  selectBucketSeconds,
  timeWeightedReturn,
  triggerLabel,
  withDrawdown,
  type EquitySample,
} from "../src/lib/equityAnalytics";

const MINUS = "\u2212"; // U+2212, wie in der UI

function series(values: number[], startIso = "2026-09-01T00:00:00.000Z", stepMinutes = 60): EquitySample[] {
  const start = Date.parse(startIso);
  return values.map((equity, i) => ({
    ts: new Date(start + i * stepMinutes * 60_000).toISOString(),
    equity,
  }));
}

test("withDrawdown rechnet gegen den Referenz-Höchststand aus dem Vorfenster", () => {
  // Fenster beginnt bereits 5 % unter dem Hoch — ohne priorPeak stünde hier 0 %.
  const curve = withDrawdown(series([9500, 9400, 9800]), 10_000);
  assert.equal(curve[0].peak, 10_000);
  assert.equal(curve[0].drawdownPct, 5);
  assert.equal(curve[0].drawdownAbs, 500);
  assert.equal(curve[1].drawdownPct, 6);
  // 9 800 bleibt unter dem Referenz-Hoch → Peak bleibt 10 000, Drawdown 2 %.
  assert.equal(curve[2].peak, 10_000);
  assert.equal(curve[2].drawdownPct, 2);
});

test("withDrawdown: ein neues Hoch im Fenster hebt den Peak an", () => {
  const curve = withDrawdown(series([9_500, 10_400]), 10_000);
  assert.equal(curve[1].peak, 10_400);
  assert.equal(curve[1].drawdownPct, 0);
});

test("withDrawdown ohne Referenz startet beim ersten Punkt (kein erfundener Peak)", () => {
  const curve = withDrawdown(series([10_000, 9_000]));
  assert.equal(curve[0].peak, 10_000);
  assert.equal(curve[0].drawdownPct, 0);
  assert.equal(curve[1].drawdownPct, 10);
});

test("computeEquityStats: maximaler Drawdown ist Peak-to-Trough, nicht Start-Abstand", () => {
  const curve = withDrawdown(series([10_000, 12_000, 11_000, 9_000, 12_100]));
  const stats = computeEquityStats(curve, { startEquity: 10_000 });

  // 12 000 → 9 000 = 25 % (der Start-Abstand wäre nur 10 %).
  assert.equal(stats.maxDrawdownPct, 25);
  assert.equal(stats.maxDrawdownAbs, 3_000);
  assert.equal(stats.maxDrawdownFrom, curve[1].ts);
  assert.equal(stats.maxDrawdownTo, curve[3].ts);
  assert.equal(stats.recoveredAt, curve[4].ts);
  assert.equal(stats.currentDrawdownPct, 0);
  assert.equal(stats.highWaterMark, 12_100);
  assert.equal(stats.peakEquity, 12_100);
  assert.equal(stats.lowEquity, 9_000);
  assert.equal(stats.returnPct, 21);
  assert.equal(stats.vsStartPct, 21);
  // Dauer der Drawdown-Phase: Peak 01:00 → Erholung 04:00 = 3 h.
  assert.equal(stats.maxDrawdownMs, 3 * 3_600_000);
});

test("computeEquityStats: offener Drawdown bleibt offen (null), nicht 0", () => {
  const curve = withDrawdown(series([10_000, 12_000, 9_000]));
  const stats = computeEquityStats(curve);
  assert.equal(stats.maxDrawdownPct, 25);
  assert.equal(stats.recoveredAt, null);
  assert.equal(stats.currentDrawdownPct, 25);
  assert.equal(stats.highWaterMark, 12_000);
});

test("computeEquityStats: leer/kurz sind „unbekannt“, nicht null Prozent", () => {
  const empty = computeEquityStats([]);
  assert.equal(empty.points, 0);
  assert.equal(empty.returnPct, null);
  assert.equal(empty.maxDrawdownPct, 0);

  const single = computeEquityStats(withDrawdown(series([10_000])));
  assert.equal(single.returnPct, 0);
  assert.equal(single.currentDrawdownPct, 0);
});

test("Tagesrenditen kommen aus Berliner Tagen, nicht UTC-Tagen", () => {
  // 22:30 UTC = 00:30 Berlin (nächster Tag) — der Tageswechsel muss dort liegen.
  const points: EquitySample[] = [
    { ts: "2026-09-01T20:00:00.000Z", equity: 10_000 }, // 22:00 Berlin, 1.9. (Tagesschluss)
    { ts: "2026-09-01T22:30:00.000Z", equity: 10_100 }, // 00:30 Berlin, 2.9.
    { ts: "2026-09-02T12:00:00.000Z", equity: 10_200 }, // 14:00 Berlin, 2.9. (Tagesschluss)
    { ts: "2026-09-03T20:00:00.000Z", equity: 9_996 }, // 22:00 Berlin, 3.9. (Tagesschluss)
  ];
  const daily = dailyReturns(points);
  // Drei Berliner Tage, zwei Übergänge — der erste Tag hat keinen Vorgänger.
  assert.deepEqual(daily.map((d) => d.day), ["2026-09-02", "2026-09-03"]);
  assert.equal(daily[0].pct, 2); // 10 000 → 10 200 (Tagesschluss 2.9.)
  assert.equal(daily[1].pct, -2); // 10 200 → 9 996

  const stats = computeEquityStats(withDrawdown(points));
  assert.equal(stats.days, 3);
  assert.equal(stats.bestDay?.pct, 2);
  assert.equal(stats.worstDay?.pct, -2);
  assert.equal(stats.positiveDays, 1);
  assert.equal(stats.negativeDays, 1);
});

test("Volatilität und Sharpe-ähnliche Kennzahl: berechnet, aber nie geraten", () => {
  const oneDay = computeEquityStats(withDrawdown(series([10_000, 10_050])));
  assert.equal(oneDay.volatilityPct, null); // nur ein Tag → keine Streuung
  assert.equal(oneDay.sharpeLike, null);

  const dayKeys = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
  const samples: EquitySample[] = [];
  let equity = 10_000;
  const moves = [1, -2, 3, -1, 2, 1];
  dayKeys.forEach((day, i) => {
    equity *= 1 + moves[i] / 100;
    samples.push({ ts: `${day}T12:00:00.000Z`, equity });
  });
  const stats = computeEquityStats(withDrawdown(samples));
  assert.equal(stats.daily.length, 5);
  assert.ok(stats.volatilityPct !== null && stats.volatilityPct > 0);
  assert.ok(stats.sharpeLike !== null);
});

test("bucketsToPoints: Extremwerte je Bucket bleiben in Zeitreihenfolge erhalten", () => {
  const points = bucketsToPoints([
    {
      tsFirst: "2026-09-01T00:00:00.000Z",
      eqFirst: "10000",
      tsMin: "2026-09-01T03:00:00.000Z",
      eqMin: "9500",
      tsMax: "2026-09-01T02:00:00.000Z",
      eqMax: "10500",
      tsLast: "2026-09-01T05:00:00.000Z",
      eqLast: "9800",
    },
    {
      tsFirst: "2026-09-01T06:00:00.000Z",
      eqFirst: "9800",
      tsMin: "2026-09-01T06:00:00.000Z",
      eqMin: "9800",
      tsMax: "2026-09-01T07:00:00.000Z",
      eqMax: "9900",
      tsLast: "2026-09-01T07:00:00.000Z",
      eqLast: "9900",
    },
  ]);

  assert.deepEqual(
    points.map((p) => p.equity),
    [10_000, 10_500, 9_500, 9_800, 9_800, 9_900]
  );
  const stats = computeEquityStats(withDrawdown(points));
  assert.equal(stats.maxDrawdownPct, 9.52381); // 10 500 → 9 500
});

test("bucketsToPoints: Bucket-Spitze geht nicht verloren, wenn das Tief danach liegt", () => {
  // Regression aus dem Live-Betrieb: Der Tagesbucket hatte first 00:00,
  // min 23:00, max 18:45 und last 23:00. Ein Filter „nur aufsteigende
  // Zeitstempel in Einfüge-Reihenfolge“ verwarf das Maximum (18:45) und damit
  // den Hochpunkt der Kurve — der Drawdown sah dadurch größer aus als er war.
  const points = bucketsToPoints([
    {
      tsFirst: "2026-10-03T00:00:00.000Z",
      eqFirst: "10796.13",
      tsMin: "2026-10-03T23:00:00.000Z",
      eqMin: "10766.08",
      tsMax: "2026-10-03T18:45:00.000Z",
      eqMax: "10828.09",
      tsLast: "2026-10-03T23:00:00.000Z",
      eqLast: "10766.08",
    },
  ]);

  // Alle drei verschiedenen Zeitpunkte bleiben, der doppelte Schlusskurs nicht.
  assert.deepEqual(points.map((p) => p.ts), [
    "2026-10-03T00:00:00.000Z",
    "2026-10-03T18:45:00.000Z",
    "2026-10-03T23:00:00.000Z",
  ]);
  assert.equal(Math.max(...points.map((p) => p.equity)), 10_828.09);
  const stats = computeEquityStats(withDrawdown(points));
  assert.equal(stats.peakEquity, 10_828.09);
});

test("downsamplePreservingExtremes: behält Extremwerte, Zeitordnung und Spannweite", () => {
  const samples: EquitySample[] = [];
  for (let i = 0; i < 1_000; i += 1) {
    const equity = i === 137 ? 5_000 : i === 613 ? 20_000 : 10_000 + Math.sin(i / 10) * 100;
    samples.push({ ts: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 60_000).toISOString(), equity });
  }
  const reduced = downsamplePreservingExtremes(samples, 50);
  assert.ok(reduced.length <= 53, `erwartet ≤ 53 Punkte, waren ${reduced.length}`);

  // Der Fehler, den dieser Test festhält: Wert und Position müssen zusammen-
  // passen — vorher stand der i-te Wert auf dem i-sten Platz, sodass die Kurve
  // nur den Fensteranfang zeigte (Downsampling-Bug).
  assert.equal(reduced[0].ts, samples[0].ts);
  assert.equal(reduced[reduced.length - 1].ts, samples[samples.length - 1].ts);
  const lastTs = Date.parse(reduced[reduced.length - 1].ts);
  const firstTs = Date.parse(reduced[0].ts);
  assert.ok(lastTs - firstTs >= 900 * 60_000, "die verdichtete Kurve muss fast das ganze Fenster abdecken");
  assert.ok(reduced.some((p) => p.equity === 5_000), "globales Minimum fehlt");
  assert.ok(reduced.some((p) => p.equity === 20_000), "globales Maximum fehlt");
  for (let i = 1; i < reduced.length; i += 1) {
    assert.ok(Date.parse(reduced[i - 1].ts) <= Date.parse(reduced[i].ts), `Zeitordnung verletzt bei ${i}`);
  }
});

test("downsamplePreservingExtremes lässt kurze Kurven unverändert", () => {
  const short = series([1, 2, 3]);
  assert.deepEqual(downsamplePreservingExtremes(short, 50), short);
});

test("selectBucketSeconds trifft die nächstbessere Bucket-Grenze", () => {
  assert.equal(selectBucketSeconds(3_600, 4), 900); // 1 h auf 4 Buckets → 15 min
  assert.equal(selectBucketSeconds(600, 100), 60); // Untergrenze bleibt der 60-s-Tick
  assert.equal(selectBucketSeconds(86_400 * 30, 60), 43_200); // Monat → 12-h-Buckets
  assert.equal(selectBucketSeconds(86_400 * 730, 60), 1_209_600); // 2 Jahre → 14-Tage-Buckets
  assert.equal(selectBucketSeconds(86_400 * 3650, 60), 2_592_000); // 10 Jahre → 30-Tage-Buckets
});

test("niceTicks erzeugt 1/2/5-Raster über den Wertebereich", () => {
  assert.deepEqual(niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(9_450, 10_550, 4).slice(0, 3), [9_500, 10_000, 10_500]);
  assert.deepEqual(niceTicks(5, 5), [5]); // kein Bereich → genau ein Tick
  assert.deepEqual(niceTicks(Number.NaN, 10), []); // ungültige Grenzen → keine Achse
});

test("buildTimeTicks rastet lange Fenster auf Berliner Mitternacht", () => {
  const from = Date.parse("2026-09-01T00:00:00.000Z");
  const to = Date.parse("2026-09-10T00:00:00.000Z"); // 9 Tage → Tages-/2-Tages-Raster
  const ticks = buildTimeTicks(from, to, 7);
  assert.ok(ticks.length >= 3);
  for (const tick of ticks) {
    // 22:00 UTC = 00:00 Berlin (Sommerzeit) — genau auf der Kalendergrenze.
    assert.equal(
      new Date(tick).toISOString().endsWith("T22:00:00.000Z"),
      true,
      `kein Berliner Tagesanfang: ${new Date(tick).toISOString()}`
    );
  }
});

test("buildTimeTicks rastet kurze Fenster auf lokale Stunden", () => {
  const from = Date.parse("2026-09-01T06:07:00.000Z");
  const to = Date.parse("2026-09-01T20:07:00.000Z");
  const ticks = buildTimeTicks(from, to, 6);
  assert.ok(ticks.length >= 2);
  for (const tick of ticks) {
    assert.equal(new Date(tick).getUTCMinutes(), 0, `nicht auf Stundenmitte: ${new Date(tick).toISOString()}`);
  }
});

test("Achsen- und Tooltip-Formatierung bleibt deutsch und vorzeichenklar", () => {
  assert.equal(formatAxisValue(9_840), "9.840");
  assert.equal(formatAxisValue(12_400), "12,4 Tsd.");
  assert.equal(formatAxisValue(1_250_000), "1,25 Mio.");
  assert.equal(formatPct(2.5), "+2,50 %");
  assert.equal(formatPct(-3.125), `${MINUS}3,13 %`);
  assert.equal(formatPct(0), "0,00 %");
  assert.equal(formatMoney(1_234.5), "+$1.234,50");
  assert.equal(formatMoney(-500), `${MINUS}$500,00`);

  const shortSpan = formatTimeTick(Date.parse("2026-09-01T06:07:00.000Z"), 6 * 3_600_000);
  assert.match(shortSpan, /^\d{2}:\d{2}$/);
  const mediumSpan = formatTimeTick(Date.parse("2026-09-01T06:07:00.000Z"), 30 * 86_400_000);
  assert.match(mediumSpan, /^\d{2}\.\d{2}\.$/);
  const longSpan = formatTimeTick(Date.parse("2026-09-01T06:07:00.000Z"), 300 * 86_400_000);
  assert.match(longSpan, /26/); // de-DE kürzt das Jahr auf zwei Stellen
});

test("triggerLabel übersetzt Snapshot-Auslöser, unbekannte Codes bleiben lesbar", () => {
  assert.equal(triggerLabel("TICK"), "Monitor-Tick (60 s)");
  assert.equal(triggerLabel("BOOT"), "Systemstart");
  assert.equal(triggerLabel("NEU"), "NEU");
  assert.equal(triggerLabel(undefined), "Snapshot");
});

// ─────────────────── Drawdown-Episoden, Monate, TWR, Log, Benchmark ──────────

test("drawdownEpisodes: Peak → Tief → Erholung mit Dauer und offener Phase", () => {
  const points = withDrawdown(
    series([
      10_000, // Hoch
      9_500, // −5 %
      9_000, // −10 % (Tief)
      9_600,
      10_000, // erholt
      10_500, // neues Hoch
      10_200, // −2,86 % (läuft noch)
    ])
  );
  const episodes = drawdownEpisodes(points, { topN: 5 });
  assert.equal(episodes.length, 2);

  const [first, second] = episodes;
  assert.equal(first.drawdownPct, 10);
  assert.equal(first.peakValue, 10_000);
  assert.equal(first.troughValue, 9_000);
  assert.equal(first.recoveredAt, points[4].ts);
  assert.equal(first.open, false);
  // Abstieg 2 h, Erholung 2 h, gesamt 4 h (Stundenraster aus `series`).
  assert.equal(first.declineMs, 2 * 3_600_000);
  assert.equal(first.recoveryMs, 2 * 3_600_000);
  assert.equal(first.totalMs, 4 * 3_600_000);

  assert.equal(second.open, true);
  assert.equal(second.recoveredAt, null);
  // Ohne Erholung läuft die Gesamtdauer bis zum letzten Punkt (nicht bis 0):
  // Peak 05:00 (10 500) → letzter Punkt 06:00 (10 200) = 1 h.
  assert.equal(second.totalMs, 3_600_000);
});

test("drawdownEpisodes: Referenz-Peak aus dem Vorfenster hat keinen Zeitpunkt im Fenster", () => {
  const points = withDrawdown(series([9_500, 9_200, 9_800]), 10_000);
  const [episode] = drawdownEpisodes(points, { topN: 1 });
  assert.equal(episode.peakValue, 10_000);
  assert.equal(episode.peakTs, null, "der Höchststand liegt vor dem Fenster — kein erfundenes Datum");
  assert.equal(episode.drawdownPct, 8); // 10 000 → 9 200
});

test("drawdownEpisodes: sortiert nach Tiefe und respektiert topN/minPct", () => {
  const points = withDrawdown(
    series([10_000, 9_900, 10_000, 9_700, 10_000, 9_000, 10_000])
  );
  const top = drawdownEpisodes(points, { topN: 2 });
  assert.equal(top.length, 2);
  assert.deepEqual(top.map((e) => e.drawdownPct), [10, 3]);
  // Schwelle 5 % blendet die kleine Episode aus.
  assert.equal(drawdownEpisodes(points, { topN: 5, minPct: 5 }).length, 1);
});

test("monthlyReturns: Monatsrenditen in Berliner Kalendergrenzen, Randmonate markiert", () => {
  const points = series(
    [10_000, 10_500],
    "2026-08-15T12:00:00.000Z",
    0
  ).concat(series([10_500, 10_500 * 1.02], "2026-09-02T12:00:00.000Z", 60 * 24));
  const months = monthlyReturns(points);
  assert.deepEqual(months.map((m) => m.ym), ["2026-08", "2026-09"]);
  assert.equal(months[0].pct, 5); // 10 000 → 10 500
  assert.equal(months[1].pct, 2); // 10 500 → 10 710
  // Beide Ränder sind angeschnitten (Fenster beginnt/endet mitten im Monat).
  assert.deepEqual(months.map((m) => m.partial), [true, true]);
});

test("finalizeMonthlyReturns: SQL-Aggregate werden zu Rendite + Anschnitt-Flag", () => {
  const rows = [
    { ym: "2026-07", first: 10_000, last: 10_400, points: 200 },
    { ym: "2026-08", first: 10_400, last: 9_880, points: 180 },
    { ym: "2026-09", first: 9_880, last: 10_200, points: 90 },
  ];
  const months = finalizeMonthlyReturns(rows, {
    since: new Date("2026-07-01T00:00:00.000Z"),
    until: new Date("2026-09-20T10:00:00.000Z"),
  });
  assert.deepEqual(months.map((m) => m.pct), [4, -5, 3.238866]);
  // Juli/August sind vollständig, September ist angeschnitten (Fenster endet
  // am 20. — mehr als die 24-h-Toleranz vor dem Monatsende).
  assert.deepEqual(months.map((m) => m.partial), [false, false, true]);
  assert.equal(months[0].year, 2026);
  assert.equal(months[0].month, 7);

  const summary = monthlySummary(months);
  assert.equal(summary.months, 3);
  assert.equal(summary.positive, 2);
  assert.equal(summary.negative, 1);
  assert.equal(summary.best?.ym, "2026-07");
  assert.equal(summary.worst?.ym, "2026-08");
});

test("timeWeightedReturn: verkettet Tagesrenditen, Cashflows werden bereinigt", () => {
  // Zwei Tage: 10 000 → 11 000 (+10 %) → 11 000 (0 %).
  const points = [
    { ts: "2026-09-01T20:00:00.000Z", equity: 10_000 },
    { ts: "2026-09-02T20:00:00.000Z", equity: 11_000 },
    { ts: "2026-09-03T20:00:00.000Z", equity: 11_000 },
  ];
  const plain = timeWeightedReturn(points);
  assert.equal(plain.days, 2);
  assert.equal(plain.twrPct, 10);
  assert.equal(plain.simplePct, 10); // ohne Cashflows identisch
  assert.equal(plain.flows.applied, false);
  assert.equal(plain.bestDayPct, 10);
  assert.equal(plain.worstDayPct, 0);

  // Einzahlung von 1 000 am 3. Tag: ohne Bereinigung „+10 %“, bereinigt 0 %.
  const withFlow = timeWeightedReturn(points, {
    flows: [{ ts: "2026-09-03T06:00:00.000Z", amount: 1_000 }],
  });
  assert.equal(withFlow.flows.applied, true);
  assert.equal(withFlow.flows.total, 1_000);
  // Tag 3: Basis 12 000, Endstand 11 000 → −8,333 %; verkettet 1,1 × 0,91666… = 0,8333 %
  assert.equal(withFlow.twrPct, 0.833333);
});

test("niceLogTicks: 1/2/5-Raster je Dekade, Rückfall auf linear ohne Spreizung", () => {
  const ticks = niceLogTicks(1_000, 100_000, 5);
  assert.deepEqual(ticks, [1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000]);
  // Innerhalb einer Dekade bleibt das lineare Raster (keine erfundene Logik).
  assert.deepEqual(niceLogTicks(10_000, 10_500, 5), niceTicks(10_000, 10_500, 5));
  // Null/Negativ ist auf einer log-Achse nicht darstellbar → linear.
  assert.deepEqual(niceLogTicks(0, 100, 5), niceTicks(0, 100, 5));
});

test("scaleBenchmarkSeries: Buy-and-Hold auf Kontostand skaliert, ohne Fortschreibung", () => {
  const candles = [
    { ts: Date.parse("2026-08-30T00:00:00.000Z"), close: 100 }, // vor dem Fenster → fällt weg
    { ts: Date.parse("2026-09-01T00:00:00.000Z"), close: 200 },
    { ts: Date.parse("2026-09-02T00:00:00.000Z"), close: 260 },
    { ts: Date.parse("2026-09-05T00:00:00.000Z"), close: 300 }, // nach dem Fenster → fällt weg
  ];
  const scaled = scaleBenchmarkSeries(candles, 10_000, {
    since: Date.parse("2026-09-01T00:00:00.000Z"),
    until: Date.parse("2026-09-03T00:00:00.000Z"),
  });
  assert.deepEqual(scaled.map((p) => p.value), [10_000, 13_000]);
  assert.equal(benchmarkReturnPct(scaled), 30);
  // Ohne Kurse im Fenster (oder ohne Startkapital) kommt nichts zurück.
  assert.deepEqual(
    scaleBenchmarkSeries(candles, 10_000, { since: Date.parse("2026-10-01T00:00:00.000Z"), until: Date.parse("2026-10-02T00:00:00.000Z") }),
    []
  );
  assert.deepEqual(scaleBenchmarkSeries(candles, 0, { since: 0, until: Number.MAX_SAFE_INTEGER }), []);
});
