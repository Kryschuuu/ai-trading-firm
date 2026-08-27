/**
 * Benchmark (Task 04): vollständiger Scan über **10.000 synthetische
 * Instrumente** mit je 120 Kerzen.
 *
 * Zeitbudget laut Vorgabe: der komplette Scan-Durchlauf muss lokal unter
 * 15 Minuten bleiben. Die Assertion prüft dieses Budget hart, das Log gibt die
 * tatsächliche Laufzeit und den Durchsatz aus.
 *
 * Der Lauf ist deterministisch (geseedete Zeitreihen, injizierte Uhr) — er
 * eignet sich damit auch als Regressionsschutz für die Trichter-Größen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SCANNER_CONFIG } from "../src/scanner/config";
import { FactorCache } from "../src/scanner/cache";
import { scanUniverse } from "../src/scanner/pipeline";
import { buildDailyArtifact } from "../src/scanner/artifacts";
import { classifyWeekly } from "../src/scanner/weekly";
import { AS_OF, syntheticInstruments, syntheticProvider } from "./fixtures/scannerFixtures";

/** Anzahl Instrumente im Benchmark. */
const INSTRUMENT_COUNT = 10_000;
/** Zeitbudget in Millisekunden (15 Minuten). */
const TIME_BUDGET_MS = 15 * 60 * 1000;

test(
  `Benchmark: ${INSTRUMENT_COUNT} Instrumente werden in unter 15 Minuten gescannt`,
  { timeout: TIME_BUDGET_MS + 60_000 },
  () => {
    const instruments = syntheticInstruments(INSTRUMENT_COUNT, 2026);
    const data = syntheticProvider(4242, 120);
    assert.equal(instruments.length, INSTRUMENT_COUNT);

    const started = performance.now();
    const scan = scanUniverse({
      instruments,
      data,
      asOf: AS_OF,
      config: DEFAULT_SCANNER_CONFIG,
      cache: new FactorCache(INSTRUMENT_COUNT),
    });
    const durationMs = performance.now() - started;

    const perInstrument = durationMs / INSTRUMENT_COUNT;
    console.log(
      `[benchmark] ${INSTRUMENT_COUNT} Instrumente · ${durationMs.toFixed(0)} ms ` +
        `(${perInstrument.toFixed(3)} ms/Instrument, ${(INSTRUMENT_COUNT / (durationMs / 1000)).toFixed(0)} Instrumente/s) · ` +
        `Budget ${TIME_BUDGET_MS} ms · geeignet ${scan.funnel.eligible.length} · ` +
        `interessant ${scan.funnel.interesting.length} · daily ${scan.funnel.daily.length} · deep ${scan.funnel.deep.length}`
    );

    assert.ok(
      durationMs < TIME_BUDGET_MS,
      `Zeitbudget überschritten: ${durationMs.toFixed(0)} ms ≥ ${TIME_BUDGET_MS} ms`
    );

    // Trichter-Invarianten bei 10.000 gescannten Instrumenten
    assert.equal(scan.funnel.scanned, INSTRUMENT_COUNT);
    assert.equal(scan.scores.length, INSTRUMENT_COUNT);
    assert.ok(scan.funnel.eligible.length <= DEFAULT_SCANNER_CONFIG.funnel.eligibleMax);
    assert.ok(scan.funnel.interesting.length <= DEFAULT_SCANNER_CONFIG.funnel.interestingMax);
    assert.ok(scan.funnel.daily.length <= DEFAULT_SCANNER_CONFIG.funnel.dailyMax);
    assert.ok(scan.funnel.deep.length <= DEFAULT_SCANNER_CONFIG.funnel.deepMax);
    assert.equal(scan.stats.passedFilters + scan.rejections.length, INSTRUMENT_COUNT);
    assert.ok(scan.funnel.eligible.length <= scan.stats.passedFilters);

    // Folgeschritte (Artefakt + Weekly) müssen im selben Budget möglich bleiben.
    const artifactStart = performance.now();
    const artifact = buildDailyArtifact(scan);
    const weekly = classifyWeekly({ scan, instruments });
    const followUpMs = performance.now() - artifactStart;
    console.log(
      `[benchmark] Artefakt + Weekly: ${followUpMs.toFixed(0)} ms · ` +
        `CORE ${weekly.summary.CORE} · ROTATION ${weekly.summary.ROTATION} · ` +
        `DISCOVERY ${weekly.summary.DISCOVERY} · EXCLUDED ${weekly.summary.EXCLUDED}`
    );
    assert.equal(artifact.funnel.scanned, INSTRUMENT_COUNT);
    assert.equal(weekly.entries.length, INSTRUMENT_COUNT);
    assert.ok(durationMs + followUpMs < TIME_BUDGET_MS);
  }
);

test("Benchmark: zweiter Lauf mit warmem Cache liefert identische Rangfolge", () => {
  const instruments = syntheticInstruments(2000, 2026);
  const data = syntheticProvider(4242, 120);
  const cache = new FactorCache(4000);

  const cold = scanUniverse({ instruments, data, asOf: AS_OF, cache, config: DEFAULT_SCANNER_CONFIG });
  const warm = scanUniverse({ instruments, data, asOf: AS_OF, cache, config: DEFAULT_SCANNER_CONFIG });

  assert.equal(cache.statistics.misses, 2000);
  assert.equal(cache.statistics.hits, 2000);
  assert.deepEqual(
    cold.funnel.daily.map((s) => [s.instrumentId, s.score]),
    warm.funnel.daily.map((s) => [s.instrumentId, s.score])
  );
  console.log(
    `[benchmark] warmer Cache: ${warm.stats.durationMs.toFixed(0)} ms vs. kalt ${cold.stats.durationMs.toFixed(0)} ms`
  );
});
