/**
 * Tests von Eignungsfiltern, Trichter und Scan-Pipeline (Task 04).
 *
 * Geprüft werden Filterreihenfolge, Größenlimits, Diversifikationsregel und
 * die Wirkung von Konfigurationsänderungen — alles deterministisch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SCANNER_CONFIG, resolveScannerConfig } from "../src/scanner/config";
import { FILTER_RULE_IDS, checkEligibility } from "../src/scanner/filters";
import { buildFunnel, selectDiversified } from "../src/scanner/funnel";
import { computeAllFactors } from "../src/scanner/factors";
import { scanUniverse, MAX_SCAN_INSTRUMENTS, toEpochMs, type ScanDataProvider } from "../src/scanner/pipeline";
import { classifyRegime } from "../src/scanner/regime";
import { scoreInstrument } from "../src/scanner/ranker";
import { FactorCache } from "../src/scanner/cache";
import type { FactorInput, InstrumentScore } from "../src/scanner/types";
import type { AssetClass, MarketInstrument } from "../src/universe/types";
import {
  AS_OF,
  AS_OF_MS,
  candlesFromCloses,
  growthSeries,
  healthyCandles,
  instrument,
  syntheticInstruments,
  syntheticProvider,
} from "./fixtures/scannerFixtures";

const config = DEFAULT_SCANNER_CONFIG;

function candidate(overrides: Partial<MarketInstrument> = {}, candles = healthyCandles()) {
  const inst = instrument(overrides);
  const input: FactorInput = {
    instrument: inst,
    candles,
    benchmarkCandles: null,
    derivatives: null,
    news: null,
    asOf: AS_OF_MS,
    config,
  };
  const factors = computeAllFactors(input);
  return {
    instrument: inst,
    factors,
    candleCount: candles.length,
    regime: classifyRegime(factors.volatility.raw, config.regime),
  };
}

function fakeScore(id: string, score: number, assetClass: AssetClass = "crypto"): InstrumentScore {
  return {
    instrumentId: id,
    assetClass,
    score,
    regime: "NORMAL",
    breakdown: [],
    factors: {} as InstrumentScore["factors"],
    asOf: AS_OF,
  };
}

// ── Filter ───────────────────────────────────────────────────────────────────

test("Filter: gesundes Instrument passiert alle Regeln", () => {
  assert.equal(checkEligibility(candidate(), config.filters), null);
});

test("Filter: Reihenfolge ist fix — die erste greifende Regel entscheidet", () => {
  // Instrument reißt gleichzeitig Status, Paper-Flag und Volumen:
  // erwartet wird die erste Regel der Liste (status-active).
  const broken = candidate({ status: "halted", paperAvailable: false, volume24h: 1 });
  assert.equal(checkEligibility(broken, config.filters)?.ruleId, "status-active");
  const noPaper = candidate({ paperAvailable: false, volume24h: 1 });
  assert.equal(checkEligibility(noPaper, config.filters)?.ruleId, "paper-available");
  assert.deepEqual(
    [...FILTER_RULE_IDS],
    [
      "status-active",
      "paper-available",
      "market-type",
      "asset-class",
      "min-candles",
      "min-volume",
      "max-spread",
      "max-execution-cost",
      "max-drawdown",
      "regime-extreme",
    ]
  );
});

test("Filter: jede Regel lehnt begründet ab", () => {
  const cases: [ReturnType<typeof candidate>, string][] = [
    [candidate({ status: "delisted" }), "status-active"],
    [candidate({ paperAvailable: false }), "paper-available"],
    [candidate({ marketType: "option" }), "market-type"],
    [candidate({ assetClass: "other" }), "asset-class"],
    [candidate({}, healthyCandles(10)), "min-candles"],
    [candidate({ volume24h: 10_000 }), "min-volume"],
    [candidate({ spread: 0.02 }), "max-spread"],
    [candidate({ takerFee: 0.01 }), "max-execution-cost"],
  ];
  for (const [c, ruleId] of cases) {
    const rejection = checkEligibility(c, config.filters);
    assert.equal(rejection?.ruleId, ruleId, `erwartete Regel ${ruleId}`);
    assert.ok((rejection?.message.length ?? 0) > 5);
    assert.equal(rejection?.instrumentId, c.instrument.id);
  }
});

test("Filter: unbekanntes Volumen/Spread wird abgelehnt (null heißt unbekannt)", () => {
  assert.equal(checkEligibility(candidate({ volume24h: null }), config.filters)?.ruleId, "min-volume");
  assert.equal(checkEligibility(candidate({ spread: null }), config.filters)?.ruleId, "max-spread");
});

test("Filter: Drawdown und EXTREME-Regime greifen als Risikoschranken", () => {
  const crash = candlesFromCloses([...growthSeries(100, 1.001, 40), ...growthSeries(100, 0.9, 40)]);
  const rejection = checkEligibility(candidate({}, crash), config.filters);
  assert.ok(rejection);
  assert.ok(["max-drawdown", "regime-extreme"].includes(rejection.ruleId));

  const wild = candlesFromCloses(Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 100 : 130)));
  assert.equal(checkEligibility(candidate({}, wild), config.filters)?.ruleId, "regime-extreme");
});

test("Filter: gelockerte Konfiguration lässt vorher abgelehnte Instrumente zu", () => {
  const relaxed = resolveScannerConfig({
    filters: { requirePaperAvailable: false, minVolume24h: 0, excludeExtremeRegime: false },
  });
  const c = candidate({ paperAvailable: false, volume24h: 10_000 });
  assert.equal(checkEligibility(c, config.filters)?.ruleId, "paper-available");
  assert.equal(checkEligibility(c, relaxed.filters), null);
});

// ── Trichter ─────────────────────────────────────────────────────────────────

test("Trichter: Ebenen schrumpfen gemäß Konfiguration 2.000 → 500 → 100 → 40", () => {
  const scores = Array.from({ length: 5000 }, (_, i) =>
    fakeScore(`BINANCE:S${String(i).padStart(5, "0")}`, 100 - i * 0.01, (["crypto", "equity", "etf", "fx", "commodity", "index"] as AssetClass[])[i % 6])
  );
  const funnel = buildFunnel(10_000, scores, config.funnel);
  assert.equal(funnel.scanned, 10_000);
  assert.equal(funnel.eligible.length, 2000);
  assert.equal(funnel.interesting.length, 500);
  assert.equal(funnel.daily.length, 100);
  assert.equal(funnel.deep.length, 40);
  assert.equal(funnel.droppedByCap.eligible, 3000);
  assert.ok(funnel.droppedByCap.interesting > 0);
});

test("Trichter: Score-Schwelle bestimmt die Ebene „interessant“", () => {
  const scores = [fakeScore("BINANCE:AAA", 90), fakeScore("BINANCE:BBB", 54.99), fakeScore("BINANCE:CCC", 55)];
  const funnel = buildFunnel(3, scores, config.funnel);
  assert.deepEqual(
    funnel.interesting.map((s) => s.instrumentId),
    ["BINANCE:AAA", "BINANCE:CCC"]
  );
  const strict = buildFunnel(3, scores, resolveScannerConfig({ funnel: { interestingMinScore: 91 } }).funnel);
  assert.equal(strict.interesting.length, 0);
  assert.equal(strict.daily.length, 0);
  assert.equal(strict.deep.length, 0);
});

test("Trichter: Diversifikationsregel begrenzt Instrumente je Anlageklasse", () => {
  const scores = Array.from({ length: 60 }, (_, i) => fakeScore(`BINANCE:C${String(i).padStart(3, "0")}`, 90 - i * 0.1, "crypto"));
  scores.push(...Array.from({ length: 20 }, (_, i) => fakeScore(`ALPACA:E${String(i).padStart(3, "0")}`, 80 - i * 0.1, "equity")));
  const funnel = buildFunnel(80, scores, config.funnel);
  assert.ok(funnel.deep.length >= config.funnel.deepMin);
  assert.ok(funnel.deep.length <= config.funnel.deepMax);
  for (const [assetClass, count] of Object.entries(funnel.deepPerAssetClass)) {
    assert.ok(count <= 10, `Klasse ${assetClass} überschreitet die (ggf. gelockerte) Grenze: ${count}`);
  }
  // Bei nur zwei Klassen und deepMin 20 muss die Grenze nachvollziehbar gelockert werden.
  assert.equal(funnel.diversificationRelaxed, true);
});

test("Trichter: harte Diversifikation ohne Lockerung bei genügend Klassen", () => {
  const classes: AssetClass[] = ["crypto", "equity", "etf", "fx", "commodity", "index"];
  const scores = Array.from({ length: 60 }, (_, i) =>
    fakeScore(`V${i % 6}:S${String(i).padStart(3, "0")}`, 90 - i * 0.1, classes[i % 6])
  );
  const funnel = buildFunnel(60, scores, config.funnel);
  assert.equal(funnel.diversificationRelaxed, false);
  for (const count of Object.values(funnel.deepPerAssetClass)) {
    assert.ok(count <= config.funnel.maxPerAssetClass);
  }
  assert.equal(funnel.deep.length, Math.min(config.funnel.deepMax, 6 * config.funnel.maxPerAssetClass));
});

test("Trichter: selectDiversified respektiert Reihenfolge und Grenze", () => {
  const ranked = [
    fakeScore("A:1", 99, "crypto"),
    fakeScore("A:2", 98, "crypto"),
    fakeScore("A:3", 97, "equity"),
    fakeScore("A:4", 96, "crypto"),
  ];
  assert.deepEqual(
    selectDiversified(ranked, 10, 2).map((s) => s.instrumentId),
    ["A:1", "A:2", "A:3"]
  );
  assert.equal(selectDiversified(ranked, 1, 5).length, 1);
});

test("Trichter: kleinere Konfiguration ändert das Ergebnis nachvollziehbar", () => {
  const scores = Array.from({ length: 300 }, (_, i) => fakeScore(`BINANCE:S${String(i).padStart(3, "0")}`, 99 - i * 0.1));
  const small = resolveScannerConfig({
    funnel: { eligibleMax: 100, interestingMax: 50, dailyMax: 10, deepMin: 2, deepMax: 5, maxPerAssetClass: 5 },
  });
  const funnel = buildFunnel(300, scores, small.funnel);
  assert.equal(funnel.eligible.length, 100);
  assert.equal(funnel.interesting.length, 50);
  assert.equal(funnel.daily.length, 10);
  assert.equal(funnel.deep.length, 5);
});

// ── Pipeline ─────────────────────────────────────────────────────────────────

test("Pipeline: scannt, filtert und rankt ein kleines Universum", () => {
  const instruments = [
    instrument({ symbol: "BTCUSDT", volume24h: 5_000_000_000, spread: 0.0001 }),
    instrument({ symbol: "ETHUSDT", volume24h: 2_000_000_000, spread: 0.0002 }),
    instrument({ symbol: "JUNKUSDT", volume24h: 1_000, spread: 0.02 }),
    instrument({ symbol: "DEADUSDT", status: "delisted" }),
  ];
  const data: ScanDataProvider = { candles: () => healthyCandles(90) };
  const scan = scanUniverse({ instruments, data, asOf: AS_OF, config });

  assert.equal(scan.stats.scanned, 4);
  assert.equal(scan.funnel.scanned, 4);
  assert.equal(scan.funnel.eligible.length, 2);
  assert.equal(scan.rejections.length, 2);
  assert.equal(scan.rejectionsByRule["status-active"], 1);
  assert.equal(scan.rejectionsByRule["min-volume"], 1);
  assert.equal(scan.scores.length, 4);
  assert.ok(scan.byId.get("BINANCE:BTCUSDT"));
  assert.equal(scan.asOf, AS_OF);
  assert.ok(scan.stats.durationMs >= 0);
});

test("Pipeline: gleiche Eingabe ⇒ byte-identisches Ergebnis (Determinismus)", () => {
  const instruments = syntheticInstruments(50, 11);
  const data = syntheticProvider(3, 90);
  const run = () => {
    const scan = scanUniverse({ instruments, data, asOf: AS_OF, config });
    return JSON.stringify({
      daily: scan.funnel.daily.map((s) => [s.instrumentId, s.score, s.breakdown]),
      deep: scan.funnel.deep.map((s) => s.instrumentId),
      rejections: scan.rejectionsByRule,
    });
  };
  assert.equal(run(), run());
});

test("Pipeline: Cache beschleunigt den zweiten Lauf und liefert identische Scores", () => {
  const instruments = syntheticInstruments(30, 5);
  const data = syntheticProvider(9, 80);
  const cache = new FactorCache();
  const first = scanUniverse({ instruments, data, asOf: AS_OF, config, cache });
  const second = scanUniverse({ instruments, data, asOf: AS_OF, config, cache });
  assert.equal(cache.statistics.misses, 30);
  assert.equal(cache.statistics.hits, 30);
  assert.deepEqual(
    first.scores.map((s) => [s.instrumentId, s.score]),
    second.scores.map((s) => [s.instrumentId, s.score])
  );
});

test("Pipeline: ohne Datenanbindung fallen alle Instrumente durch den Historie-Filter", () => {
  const scan = scanUniverse({ instruments: [instrument()], asOf: AS_OF, config });
  assert.equal(scan.funnel.eligible.length, 0);
  assert.equal(scan.rejectionsByRule["min-candles"], 1);
});

test("Pipeline: ungültiger Zeitpunkt und zu große Läufe werden abgelehnt", () => {
  assert.throws(() => scanUniverse({ instruments: [], asOf: "kein-datum", config }), /asOf/);
  assert.equal(toEpochMs(new Date(AS_OF)), AS_OF_MS);
  assert.equal(toEpochMs(AS_OF_MS), AS_OF_MS);
  const many = { length: MAX_SCAN_INSTRUMENTS + 1 } as unknown as MarketInstrument[];
  assert.throws(() => scanUniverse({ instruments: many, asOf: AS_OF, config }), /max\./);
});

test("Pipeline: Score eines Instruments stimmt mit der Einzelberechnung überein", () => {
  const inst = instrument({ symbol: "SOLUSDT" });
  const candles = healthyCandles(100);
  const scan = scanUniverse({ instruments: [inst], data: { candles: () => candles }, asOf: AS_OF, config });
  const direct = scoreInstrument({
    instrument: inst,
    candles,
    benchmarkCandles: null,
    derivatives: null,
    news: null,
    asOf: AS_OF_MS,
    config,
  });
  assert.equal(scan.byId.get(inst.id)?.score, direct.score);
});
