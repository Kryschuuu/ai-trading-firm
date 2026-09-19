/**
 * Multi-TF-Aggregation (GAP-07, v1.47.0) — D3.
 *
 * Pflichtfälle des Tickets:
 *  - 4h-Anker korrekt (00/04/08/12/16/20 UTC), 1d-Anker 00:00 UTC.
 *  - OHLCV konsolidiert (open/close/high/low/volume), Envelope konsistent.
 *  - Unvollständige Schlusskerze wird NIEMALS aggregiert (partial).
 *  - Zwei Läufe ⇒ byte-identisches Ergebnis (Determinismus).
 *  - Zeitmaske: nur abgeschlossene Intervalle ≤ t.
 *  - Keine Mutation der Eingabeserie (Freeze).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGGREGATION_TARGETS,
  aggregateCandles,
  checkAggregationConsistency,
  type QualityCandle,
} from "../../src/marketdata";

const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z (UTC-Mitternacht)

/** Stündliche Kerze mit eindeutigen Werten: Close steigt, High/Low umschließen. */
function hour(ts: number, idx: number): QualityCandle {
  const open = 100 + idx;
  const close = 100 + idx + 0.5;
  return {
    time: ts,
    open,
    high: open + 2,
    low: open - 1,
    close,
    volume: 10 + idx,
  };
}

/** 24 stündliche Kerzen eines UTC-Tages ab T0. */
function dayCandles(start: number = T0, count: number = 24): QualityCandle[] {
  return Array.from({ length: count }, (_, i) => hour(start + i * H, i));
}

// ── 4h-Anker ─────────────────────────────────────────────────────────────────

test("4h: Anker exakt 00/04/08/12/16/20 UTC (UTC-Mitternacht verankert)", () => {
  const res = aggregateCandles(dayCandles(), "1h", "4h", { nowMs: T0 + DAY + 1 });
  assert.deepEqual(res.bucketStarts, [0, 4, 8, 12, 16, 20].map((h) => T0 + h * H));
  for (const ts of res.bucketStarts) {
    const utcHour = new Date(ts).getUTCHours();
    assert.ok([0, 4, 8, 12, 16, 20].includes(utcHour), `Bucket ${ts} auf 4h-UTC-Anker`);
  }
});

test("1d: Anker exakt 00:00 UTC", () => {
  const res = aggregateCandles(dayCandles(), "1h", "1d", { nowMs: T0 + DAY + 1 });
  assert.equal(res.candles.length, 1);
  assert.equal(res.candles[0].time, T0);
  assert.equal(new Date(res.candles[0].time!).getUTCHours(), 0);
});

// ── OHLCV-Korrektur ──────────────────────────────────────────────────────────

test("4h: OHLCV korrekt konsolidiert (Handrechnung)", () => {
  const res = aggregateCandles(dayCandles(), "1h", "4h", { nowMs: T0 + DAY + 1 });
  const first = res.candles[0];
  // Bucket 00:00 = Kerzen i=0..3: open=i0, close=i3, high=max, low=min, vol=sum.
  assert.equal(first.open, 100, "open der ERSTEN Sub-Kerze");
  assert.equal(first.close, 103.5, "close der LETZTEN Sub-Kerze");
  assert.equal(first.high, 103 + 2, "max der Highs (Sub i=3: 103+2)");
  assert.equal(first.low, 100 - 1, "min der Lows (Sub i=0: 100-1)");
  assert.equal(first.volume, 10 + 11 + 12 + 13, "Summe der Sub-Volumen");

  // Zweiter Bucket (04:00, i=4..7) als Unabhängigkeitsnachweis.
  const second = res.candles[1];
  assert.equal(second.time, T0 + 4 * H);
  assert.equal(second.open, 104);
  assert.equal(second.close, 107.5);
  assert.equal(second.high, 107 + 2);
  assert.equal(second.low, 104 - 1);
  assert.equal(second.volume, 14 + 15 + 16 + 17);
});

test("Konsistenz-Check: high/low-Envelope + open/close/volume gegen die Quelle", () => {
  const source = dayCandles();
  const res = aggregateCandles(source, "1h", "4h", { nowMs: T0 + DAY + 1 });
  assert.deepEqual(checkAggregationConsistency(source, res.candles, "4h"), []);

  const day = aggregateCandles(source, "1h", "1d", { nowMs: T0 + DAY + 1 });
  assert.deepEqual(checkAggregationConsistency(source, day.candles, "1d"), []);
});

test("Konsistenz-Check: manipuliertes Aggregat wird gefangen (high zu niedrig)", () => {
  const source = dayCandles();
  const res = aggregateCandles(source, "1h", "4h", { nowMs: T0 + DAY + 1 });
  const tampered = res.candles.map((c, i) =>
    i === 0 ? { ...c, high: c.high! - 5 } : c,
  );
  const issues = checkAggregationConsistency(source, tampered, "4h");
  assert.ok(issues.length > 0, "verletzte Envelope muss einen Befund liefern");
  assert.ok(issues.some((x) => x.includes("high")), `Befund benennt high: ${issues}`);
});

// ── Unvollständige Kerze ─────────────────────────────────────────────────────

test("Partial: unvollständige Schlusskerze wird NICHT aggregiert (markiert + ausgeschlossen)", () => {
  // 15 Kerzen (00..14): Buckets 00/04/08 vollständig, Bucket 12 nur 3/4.
  const res = aggregateCandles(dayCandles(T0, 15), "1h", "4h", { nowMs: T0 + 16 * H });
  assert.equal(res.candles.length, 3, "nur die drei vollständigen Buckets");
  assert.equal(res.partial.length, 1, "genau ein partialer Bucket");
  assert.equal(res.partial[0].ts, T0 + 12 * H);
  assert.equal(res.partial[0].received, 3);
  assert.equal(res.partial[0].expected, 4);
  assert.ok(!res.bucketStarts.includes(T0 + 12 * H), "12:00-Bucket fehlt im Ergebnis");
});

test("Partial: 1d mit 23 von 24 Kerzen ⇒ keine 1d-Kerze", () => {
  const res = aggregateCandles(dayCandles(T0, 23), "1h", "1d", { nowMs: T0 + DAY });
  assert.equal(res.candles.length, 0);
  assert.equal(res.partial.length, 1);
  assert.equal(res.partial[0].received, 23);
});

// ── Zeitmaske ────────────────────────────────────────────────────────────────

test("Zeitmaske: offene Periode (bucketEnd > nowMs) wird nie ausgegeben", () => {
  // Alle 24 Kerzen vorhanden, aber now liegt um 18:00 — Bucket 16:00–20:00
  // und 20:00–24:00 sind offen, obwohl alle Sub-Kerzen da wären (z. B. aus
  // einer Backfill-Serie). Nur abgeschlossene Perioden ≤ 18:00 dürfen stehen.
  const res = aggregateCandles(dayCandles(), "1h", "4h", { nowMs: T0 + 18 * H });
  assert.equal(res.candles.length, 4, "00/04/08/12 — nicht 16/20");
  assert.deepEqual(res.bucketStarts, [0, 4, 8, 12].map((h) => T0 + h * H));
  assert.equal(res.partial.length, 2, "offene Buckets sind partial, nicht still weggeworfen");
  assert.deepEqual(
    res.partial.map((p) => p.ts),
    [T0 + 16 * H, T0 + 20 * H],
  );
  assert.equal(res.partial[0].received, 4, "vollständig in der Quelle, aber Periode offen");
});

test("Zeitmaske: ohne nowMs zählt nur die Vollständigkeit", () => {
  const res = aggregateCandles(dayCandles(), "1h", "4h");
  assert.equal(res.candles.length, 6, "alle vollständigen Buckets");
});

// ── Determinismus ────────────────────────────────────────────────────────────

test("Determinismus: zwei Läufe ⇒ byte-identisches Ergebnis", () => {
  const source = dayCandles(T0, 25); // 25 Kerzen ⇒ letzter 4h-Bucket partial
  const a = aggregateCandles(source, "1h", "4h", { nowMs: T0 + DAY + 2 * H });
  const b = aggregateCandles(source, "1h", "4h", { nowMs: T0 + DAY + 2 * H });
  assert.equal(JSON.stringify(a), JSON.stringify(b));

  const da = aggregateCandles(source, "1h", "1d", { nowMs: T0 + DAY + 2 * H });
  const db = aggregateCandles(source, "1h", "1d", { nowMs: T0 + DAY + 2 * H });
  assert.equal(JSON.stringify(da), JSON.stringify(db));
});

test("Determinismus: Ankunftsreihenfolge der Quelle ist egal (interne Sortierung)", () => {
  const source = dayCandles();
  const shuffled = [...source].sort(() => 0.5 - Math.random()); // deterministischer Shuffle-Proxy
  const reversed = [...source].reverse();
  const a = aggregateCandles(source, "1h", "4h", { nowMs: T0 + DAY + 1 });
  const b = aggregateCandles(reversed, "1h", "4h", { nowMs: T0 + DAY + 1 });
  const c = aggregateCandles(shuffled, "1h", "4h", { nowMs: T0 + DAY + 1 });
  assert.equal(JSON.stringify(a), JSON.stringify(b), "Reihenfolge (reversed) irrelevant");
  assert.equal(JSON.stringify(a), JSON.stringify(c), "Reihenfolge (shuffled) irrelevant");
});

// ── Immutabilität ────────────────────────────────────────────────────────────

test("Immutabilität: gefrorene Eingabeserie bleibt unangetastet (Freeze)", () => {
  const source = dayCandles();
  for (const c of source) Object.freeze(c);
  Object.freeze(source);
  assert.doesNotThrow(() => aggregateCandles(source, "1h", "4h", { nowMs: T0 + DAY + 1 }));
  assert.deepEqual(source[0], hour(T0, 0));
});

// ── Vertrag/Abwehr ───────────────────────────────────────────────────────────

test("Vertrag: nur 1h-Quelle und erlaubte Ziele (4h/1d) — sonst Wurf", () => {
  const source = dayCandles();
  assert.throws(() => aggregateCandles(source, "30m", "1h"), /Quell-Timeframe/);
  assert.throws(() => aggregateCandles(source, "1h", "5d"), /nicht erlaubt/);
  assert.deepEqual(AGGREGATION_TARGETS, ["4h", "1d"]);
});

test("Robustheit: Kerzen ohne Zeitstempel werden verworfen, ohne Crash", () => {
  const source = dayCandles(T0, 4); // 00..03:00 ⇒ Bucket 00 vollständig
  source.push({ open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 } as QualityCandle);
  const res = aggregateCandles(source, "1h", "4h", { nowMs: T0 + 5 * H });
  assert.equal(res.candles.length, 1, "4 gültige Kerzen ⇒ ein vollständiger Bucket");
  assert.equal(res.partial.length, 0, "ts-freie Kerze wird verworfen, nicht gezählt");
});
