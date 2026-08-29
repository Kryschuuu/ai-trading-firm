/**
 * Tests des expliziten Readiness-Zustands (OPS-009).
 *
 * `assessDataReadiness` ist eine **reine** Funktion: kein I/O, keine Uhr, keine
 * Mutation der Eingaben. Sie trennt Infrastruktur (`WARMING`/`ERROR`) von
 * Fachlogik und meldet fehlende Historie deterministisch, statt sie zu
 * verstecken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { MarketCandle } from "../src/lib/marketdata/types";
import type { MarketInstrument } from "../src/universe/types";
import { assessDataReadiness, MAX_WORST_OFFENDERS } from "../src/scanner/warmup";
import { instrument } from "./fixtures/scannerFixtures";

const REQUIRED = 61;

/** Baut `count` Instrumente mit stabilen, sortierbaren IDs. */
function seedInstruments(count: number): MarketInstrument[] {
  return Array.from({ length: count }, (_, i) =>
    instrument({ venue: "BINANCE", symbol: `SEED${String(i).padStart(3, "0")}USDT` }),
  );
}

/** `count` Dummy-Kerzen (Inhalt egal — nur die Länge zählt). */
function candles(count: number): MarketCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: i,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1,
  }));
}

test("scanner readiness reports missing history instead of hiding it", () => {
  const seed = seedInstruments(26);
  const readiness = assessDataReadiness({
    instruments: seed,
    historyByInstrument: new Map(),
    requiredCandles: REQUIRED,
  });
  assert.equal(readiness.status, "WARMING");
  if (readiness.status !== "WARMING") return;
  assert.equal(readiness.missing, 26);
  assert.equal(readiness.warmed, 0);
  assert.equal(readiness.instruments, 26);
  assert.equal(readiness.requiredCandles, REQUIRED);
});

test("fully warmed universe reports READY", () => {
  const seed = seedInstruments(5);
  const history = new Map(seed.map((i) => [i.id, candles(REQUIRED + 10)] as const));
  const readiness = assessDataReadiness({ instruments: seed, historyByInstrument: history, requiredCandles: REQUIRED });
  assert.equal(readiness.status, "READY");
  if (readiness.status !== "READY") return;
  assert.equal(readiness.warmed, 5);
  assert.equal(readiness.missing, 0);
});

test("boundary: exactly requiredCandles counts as warmed", () => {
  const seed = seedInstruments(1);
  const history = new Map([[seed[0].id, candles(REQUIRED)] as const]);
  const readiness = assessDataReadiness({ instruments: seed, historyByInstrument: history, requiredCandles: REQUIRED });
  assert.equal(readiness.status, "READY");
});

test("boundary: requiredCandles - 1 counts as warming", () => {
  const seed = seedInstruments(1);
  const history = new Map([[seed[0].id, candles(REQUIRED - 1)] as const]);
  const readiness = assessDataReadiness({ instruments: seed, historyByInstrument: history, requiredCandles: REQUIRED });
  assert.equal(readiness.status, "WARMING");
  if (readiness.status !== "WARMING") return;
  assert.equal(readiness.missing, 1);
  assert.equal(readiness.worstOffenders[0].candles, REQUIRED - 1);
});

test("data errors dominate: any fetch error yields ERROR, not WARMING", () => {
  const seed = seedInstruments(3);
  // Selbst wenn alle Instrumente gewärmt wären: ein echter Fetch-Fehler → ERROR.
  const history = new Map(seed.map((i) => [i.id, candles(REQUIRED + 5)] as const));
  const readiness = assessDataReadiness({
    instruments: seed,
    historyByInstrument: history,
    requiredCandles: REQUIRED,
    dataErrors: new Map([[seed[1].id, "HTTP 503 vom Venue"]]),
  });
  assert.equal(readiness.status, "ERROR");
  if (readiness.status !== "ERROR") return;
  assert.equal(readiness.failures.length, 1);
  assert.equal(readiness.failures[0].instrumentId, seed[1].id);
  assert.match(readiness.failures[0].reason, /503/);
});

test("worstOffenders is deterministic and capped at 10", () => {
  // 15 Offender mit variierenden Kerzenzahlen; erwartet: aufsteigend nach
  // candles, dann instrumentId, gekappt auf 10.
  const seed = seedInstruments(15);
  const history = new Map<string, MarketCandle[]>();
  seed.forEach((inst, idx) => {
    history.set(inst.id, candles(idx % 5)); // 0..4 Kerzen → viele Gleichstände
  });

  const a = assessDataReadiness({ instruments: seed, historyByInstrument: history, requiredCandles: REQUIRED });
  const b = assessDataReadiness({ instruments: [...seed].reverse(), historyByInstrument: history, requiredCandles: REQUIRED });
  assert.equal(a.status, "WARMING");
  assert.equal(b.status, "WARMING");
  if (a.status !== "WARMING" || b.status !== "WARMING") return;

  assert.equal(a.worstOffenders.length, MAX_WORST_OFFENDERS);
  // Determinismus: Reihenfolge der Eingabe darf das Ergebnis nicht ändern.
  assert.deepEqual(a.worstOffenders, b.worstOffenders);

  // Sortierung: candles asc, dann instrumentId asc.
  for (let i = 1; i < a.worstOffenders.length; i++) {
    const prev = a.worstOffenders[i - 1];
    const cur = a.worstOffenders[i];
    const ordered =
      prev.candles < cur.candles || (prev.candles === cur.candles && prev.instrumentId <= cur.instrumentId);
    assert.ok(ordered, `nicht deterministisch sortiert an Index ${i}`);
  }
});

test("assessDataReadiness is pure — identical result, no input mutation (deepFreeze)", () => {
  const seed = seedInstruments(4);
  const history = new Map<string, readonly MarketCandle[]>([
    [seed[0].id, Object.freeze(candles(REQUIRED))],
    [seed[1].id, Object.freeze(candles(3))],
    [seed[2].id, Object.freeze(candles(0))],
    // seed[3] fehlt bewusst → 0 Kerzen
  ]);
  Object.freeze(history);
  const input = Object.freeze({ instruments: Object.freeze(seed), historyByInstrument: history, requiredCandles: REQUIRED });

  const first = assessDataReadiness(input);
  const second = assessDataReadiness(input);
  assert.deepEqual(first, second);
  // Eingaben unverändert (Freeze würde bei Mutation werfen — hier zusätzlich explizit):
  assert.equal(history.size, 3);
  assert.equal(seed.length, 4);
});

test("readiness output contains no sensitive paths or hostnames", () => {
  const seed = seedInstruments(1);
  const readiness = assessDataReadiness({
    instruments: seed,
    historyByInstrument: new Map(),
    requiredCandles: REQUIRED,
    dataErrors: new Map([[seed[0].id, "connect ECONNREFUSED https://api.internal.example.com/v1/kline /srv/secret/path/data"]]),
  });
  assert.equal(readiness.status, "ERROR");
  if (readiness.status !== "ERROR") return;
  const reason = readiness.failures[0].reason;
  assert.doesNotMatch(reason, /https?:\/\//, "keine URLs in der Readiness-Ausgabe");
  assert.doesNotMatch(reason, /\/srv\/secret/, "keine Pfade in der Readiness-Ausgabe");
});
